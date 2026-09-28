/**
 * Web Push without dependencies: VAPID (RFC 8292) and payload encryption
 * (RFC 8291 / RFC 8188, aes128gcm) on top of node:crypto, plus a JSON file
 * with the browser subscriptions.
 *
 * Flow:
 *   browser  ── PushManager.subscribe(applicationServerKey) ──► push service
 *   browser  ── POST /api/push/subscribe {endpoint, keys}   ──► owleye (stored)
 *   owleye   ── encrypted payload + VAPID JWT ──► push service ──► browser's
 *   service worker shows the notification, even with the page closed.
 *
 * Only the subscriber's browser can read the payload: it is encrypted to the
 * P-256 key the browser generated when subscribing, the push service just
 * relays the bytes.
 */
import {
  createCipheriv,
  createECDH,
  createPrivateKey,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign as signRaw,
} from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

import { safeFetch } from './net-guard.js';

const TIMEOUT_MS = 15000;
const RECORD_SIZE = 4096;
/** A payload above this will not fit in one record on every push service. */
export const MAX_PAYLOAD_BYTES = 3800;

// --- Encoding helpers --------------------------------------------------------

export function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

export function fromB64url(str) {
  return Buffer.from(String(str).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

// --- VAPID keys --------------------------------------------------------------

/** @returns {{ publicKey: string, privateKey: string }} base64url, public = 65-byte uncompressed point */
export function generateVapidKeys() {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' });
  const x = fromB64url(jwk.x);
  const y = fromB64url(jwk.y);
  return {
    publicKey: b64url(Buffer.concat([Buffer.from([0x04]), x, y])),
    privateKey: jwk.d,
  };
}

function privateKeyObject({ publicKey, privateKey }) {
  const pub = fromB64url(publicKey);
  if (pub.length !== 65 || pub[0] !== 0x04) throw new Error('VAPID public key must be a 65-byte uncompressed P-256 point');
  return createPrivateKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: b64url(pub.subarray(1, 33)),
      y: b64url(pub.subarray(33, 65)),
      d: b64url(fromB64url(privateKey)),
    },
    format: 'jwk',
  });
}

/**
 * Authorization header for one push service origin. The JWT is signed with
 * ES256 in the raw r||s form that the RFC expects, not DER.
 */
export function vapidAuthorization(endpoint, { publicKey, privateKey, subject }, { expiresInSeconds = 12 * 3600 } = {}) {
  const aud = new URL(endpoint).origin;
  const header = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64url(
    JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + expiresInSeconds, sub: subject }),
  );
  const unsigned = `${header}.${claims}`;
  const signature = signRaw('sha256', Buffer.from(unsigned), {
    key: privateKeyObject({ publicKey, privateKey }),
    dsaEncoding: 'ieee-p1363',
  });
  return `vapid t=${unsigned}.${b64url(signature)}, k=${publicKey}`;
}

// --- Payload encryption (RFC 8291) -------------------------------------------

/**
 * @param {Buffer|string} payload
 * @param {{ p256dh: string, auth: string }} keys  from the browser's PushSubscription
 * @returns {Buffer} aes128gcm body: salt(16) | rs(4) | idlen(1) | as_public(65) | ciphertext
 */
export function encryptPayload(payload, keys) {
  const plaintext = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  if (plaintext.length > MAX_PAYLOAD_BYTES) throw new Error(`payload is ${plaintext.length} bytes, limit ${MAX_PAYLOAD_BYTES}`);

  const uaPublic = fromB64url(keys.p256dh);
  const authSecret = fromB64url(keys.auth);
  if (uaPublic.length !== 65) throw new Error('subscription p256dh must be 65 bytes');
  if (authSecret.length !== 16) throw new Error('subscription auth must be 16 bytes');

  const ecdh = createECDH('prime256v1');
  const asPublic = ecdh.generateKeys();
  const sharedSecret = ecdh.computeSecret(uaPublic);

  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', sharedSecret, authSecret, keyInfo, 32));

  const salt = randomBytes(16);
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));

  // One record; 0x02 marks it as the last one. No padding.
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([0x02])])), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.alloc(16 + 4 + 1);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, ciphertext]);
}

// --- Delivery ----------------------------------------------------------------

/**
 * Send one notification. Resolves with { status, gone } — `gone` means the
 * push service says the subscription no longer exists and should be dropped.
 */
export async function sendPush(subscription, payload, vapid, { ttl = 3600, urgency = 'high', topic, allowLoopbackHttp = false } = {}) {
  const body = encryptPayload(payload, subscription.keys);
  const headers = {
    authorization: vapidAuthorization(subscription.endpoint, vapid),
    'content-encoding': 'aes128gcm',
    'content-type': 'application/octet-stream',
    'content-length': String(body.length),
    ttl: String(ttl),
    urgency,
  };
  if (topic) headers.topic = topic;

  // The endpoint is attacker-influenced (it comes in with the subscription),
  // so it goes through the SSRF guard: HTTPS only, no private addresses, and a
  // push service must not redirect us to a different origin.
  const res = await safeFetch(
    subscription.endpoint,
    { method: 'POST', headers, body },
    { allowLoopbackHttp, sameOriginOnly: true, timeoutMs: TIMEOUT_MS },
  );
  const gone = res.status === 404 || res.status === 410;
  if (!res.ok && !gone) {
    const text = (await res.text().catch(() => '')).slice(0, 200);
    throw new Error(`push service responded ${res.status}${text ? `: ${text}` : ''}`);
  }
  return { status: res.status, gone };
}

// --- Subscription store ------------------------------------------------------

/**
 * Opens <dataDir>/webpush/: loads or creates the VAPID pair, loads the
 * subscriptions. Env-supplied keys win over the cached pair.
 */
export async function openStore(config) {
  const dir = join(config.dataDir, 'webpush');
  await mkdir(dir, { recursive: true });
  const keysFile = join(dir, 'vapid.json');
  const subsFile = join(dir, 'subscriptions.json');

  let vapid;
  let generated = false;
  if (config.webpush.publicKey && config.webpush.privateKey) {
    vapid = { publicKey: config.webpush.publicKey, privateKey: config.webpush.privateKey };
  } else {
    vapid = await readJson(keysFile, null);
    if (!vapid?.publicKey || !vapid?.privateKey) {
      vapid = generateVapidKeys();
      await writeJsonAtomic(keysFile, vapid);
      generated = true;
    }
  }
  privateKeyObject(vapid); // throws early on a malformed pair
  vapid = { ...vapid, subject: config.webpush.subject };

  const maxPerSession = config.webpush.maxSubsPerSession ?? 20;

  let subscriptions = await readJson(subsFile, []);
  if (!Array.isArray(subscriptions)) subscriptions = [];
  let writing = Promise.resolve();
  const persist = () => {
    writing = writing.then(() => writeJsonAtomic(subsFile, subscriptions)).catch(() => {});
    return writing;
  };

  return {
    vapid,
    generated,
    dir,
    list: (session) => (session ? subscriptions.filter((s) => (s.session ?? 'default') === session) : subscriptions.slice()),
    count: (session) => (session ? subscriptions.filter((s) => (s.session ?? 'default') === session).length : subscriptions.length),

    /** Validates a PushSubscription.toJSON() and stores it (replacing the same endpoint). */
    /**
     * `token` is what the subscriber authenticated with; links in the push
     * payload carry it so the notification opens the clip on that device
     * (iOS keeps a separate cookie jar for a home-screen app). The file is
     * mode 0600 and already holds the subscriber's push secrets.
     */
    async add(raw, label = '', token = '', session = 'default') {
      const sub = normalizeSubscription(raw, { allowLoopbackHttp: config.devAllowInsecureOutbound === true });
      const replacing = subscriptions.some((s) => s.endpoint === sub.endpoint && (s.session ?? 'default') === session);
      const inSession = subscriptions.filter((s) => (s.session ?? 'default') === session).length;
      if (!replacing && inSession >= maxPerSession) {
        throw new Error(`too many push subscriptions for this session (max ${maxPerSession})`);
      }
      subscriptions = subscriptions.filter((s) => s.endpoint !== sub.endpoint);
      subscriptions.push({ ...sub, label: String(label).slice(0, 120), addedAt: new Date().toISOString(), token: String(token), session });
      await persist();
      return sub;
    },

    /** A device can only unsubscribe endpoints registered in its own session. */
    async remove(endpoint, session = 'default') {
      const before = subscriptions.length;
      subscriptions = subscriptions.filter((s) => s.endpoint !== endpoint || (s.session ?? 'default') !== session);
      if (subscriptions.length !== before) await persist();
      return before - subscriptions.length;
    },
  };
}

export function normalizeSubscription(raw, { allowLoopbackHttp = false } = {}) {
  const endpoint = raw?.endpoint;
  const p256dh = raw?.keys?.p256dh;
  const auth = raw?.keys?.auth;
  const httpsOk = typeof endpoint === 'string' && /^https:\/\//.test(endpoint);
  const devLoopbackOk = allowLoopbackHttp && typeof endpoint === 'string' && /^http:\/\/(127\.0\.0\.1|localhost)/.test(endpoint);
  if (!httpsOk && !devLoopbackOk) {
    throw new Error('subscription endpoint must be an https URL');
  }
  if (typeof p256dh !== 'string' || fromB64url(p256dh).length !== 65) throw new Error('subscription keys.p256dh is invalid');
  if (typeof auth !== 'string' || fromB64url(auth).length !== 16) throw new Error('subscription keys.auth is invalid');
  return { endpoint, keys: { p256dh, auth }, expirationTime: raw.expirationTime ?? null };
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(tmp, file);
}
