#!/usr/bin/env node
/**
 * owleye server.
 *
 * Serves the camera web UI, receives motion events from it, and fans them out
 * to adapters (file, Telegram, ntfy, web push, webhook, console). Also watches
 * heartbeats, so a camera that gets unplugged or covered raises an alert of
 * its own.
 *
 *   node server/index.js            # http://localhost:8443  (Mac, local camera)
 *   node server/index.js --https    # https://<lan-ip>:8443  (phone camera too)
 */
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { extname, join, normalize, relative, resolve, sep } from 'node:path';
import { randomUUID, timingSafeEqual } from 'node:crypto';

import { loadConfig } from './config.js';
import { initAdapters, dispatch } from './adapters/index.js';
import { eventFileBase } from './adapters/file.js';
import { pushStore } from './adapters/webpush.js';
import { ensureCertificate, localAddresses } from './tls.js';
import { DEFAULT_SESSION, openSessionStore, sessionDir } from './sessions.js';
import { evictToFit, pruneExpired, pruneSession, sessionUsageBytes } from './storage.js';
import { isLang, parseAcceptLanguage, pickLang, translator } from '../public/lib/i18n.js';

const config = loadConfig();
const startedAt = Date.now();

/** Sessions (see sessions.js); opened in main(). */
let sessionStore = null;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.gif': 'image/gif',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.mp4': 'video/mp4',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

/** In-memory feeds of recent events plus SSE listeners, both per session. */
/** session id -> newest-first event entries */
const feeds = new Map();
/** session id -> Set of SSE responses */
const streams = new Map();
/** "session\0device" -> { session, device, lastSeen, online, meta } */
const devices = new Map();

const feedOf = (id) => feeds.get(id) ?? feeds.set(id, []).get(id);
const streamsOf = (id) => streams.get(id) ?? streams.set(id, new Set()).get(id);

/** Sign-ups per IP inside the window, when OWLEYE_OPEN_SIGNUP is on. */
const SIGNUP_WINDOW_MS = 10 * 60_000;
const SIGNUP_PER_IP = 5;
const signups = new Map();
/** Timestamps of every recent sign-up, for the cross-IP flood cap. */
let signupTimes = [];

/** Empty, untouched sessions are swept after this long. */
const EMPTY_SESSION_TTL_MS = 24 * 60 * 60_000;
/** How often the background sweep runs. */
const CLEANUP_INTERVAL_MS = 10 * 60_000;
/** Bound the clock skew accepted in a client-supplied event timestamp. */
const MAX_AT_DRIFT_MS = 24 * 60 * 60_000;

/** Per-session POST /api/event timestamps, for the rate limit. */
const eventHits = new Map();
/** Per-session promise chain, so quota check + write can't interleave. */
const sessionLocks = new Map();

let adapters = [];

function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

/**
 * The client's address. Behind `trustedProxies` reverse proxies it comes from
 * X-Forwarded-For, counted from the right: the rightmost entries are appended
 * by our own trusted proxies, so the (trustedProxies)-th from the end is the
 * address the outermost trusted proxy saw. A client cannot forge that; any
 * value it puts in the header lands further left and is ignored.
 */
function clientIp(req) {
  if (config.trustedProxies > 0) {
    const chain = String(req.headers['x-forwarded-for'] || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (chain.length) {
      const idx = chain.length - config.trustedProxies;
      return chain[idx >= 0 ? idx : 0];
    }
  }
  return req.socket.remoteAddress ?? '?';
}

/** Serialize work for one session; failures do not wedge the chain. */
function withSessionLock(id, fn) {
  const prev = sessionLocks.get(id) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  sessionLocks.set(
    id,
    next.then(
      () => {},
      () => {},
    ),
  );
  return next;
}

/** Sliding-window rate limit for POST /api/event, per session. */
function rateLimitEvent(sessionId) {
  const now = Date.now();
  const window = 60_000;
  const hits = (eventHits.get(sessionId) ?? []).filter((t) => now - t < window);
  if (hits.length >= config.eventRatePerMinute) {
    eventHits.set(sessionId, hits);
    return { ok: false, retryAfter: Math.max(1, Math.ceil((window - (now - hits[0])) / 1000)) };
  }
  hits.push(now);
  eventHits.set(sessionId, hits);
  return { ok: true };
}

/**
 * Validate a client-supplied event timestamp. Returns a canonical ISO string
 * that is safe to build a path from, or an error. Absent → server time.
 */
const ISO_8601 = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

function normalizeAt(raw) {
  if (raw === undefined || raw === null) return { at: new Date().toISOString() };
  if (typeof raw !== 'string') return { error: 'meta.at must be an ISO 8601 string' };
  // Strict shape first: Date.parse is lenient and would accept trailing junk
  // (e.g. a path fragment) as a valid date, which must never reach the path.
  if (!ISO_8601.test(raw)) return { error: 'meta.at must be an ISO 8601 date' };
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return { error: 'meta.at is not a valid ISO 8601 date' };
  if (Math.abs(ms - Date.now()) > MAX_AT_DRIFT_MS) return { error: 'meta.at is too far from server time' };
  return { at: new Date(ms).toISOString() };
}

/** Retention + size budget for every session; one failure never stops the rest. */
async function cleanupStorage(now = Date.now()) {
  const opts = { maxBytes: config.sessionMaxBytes, retentionMs: config.retentionSeconds * 1000 };
  const dirs = [join(config.dataDir, 'events'), ...sessionStore.list().map((s) => join(sessionDir(config.dataDir, s.id), 'events'))];
  for (const dir of dirs) {
    try {
      await pruneSession(dir, opts, now, console);
    } catch (err) {
      log(`cleanup failed for ${dir}: ${err.message}`);
    }
  }
  try {
    const swept = await purgeEmptySessions(now);
    if (swept) log(`swept ${swept} empty session(s)`);
  } catch (err) {
    log(`empty-session sweep failed: ${err.message}`);
  }
}

/** Remove non-default sessions that are empty on disk and long untouched. */
async function purgeEmptySessions(now = Date.now()) {
  let removed = 0;
  for (const s of sessionStore.list()) {
    const lastMs = Date.parse(s.lastSeenAt ?? s.createdAt);
    const inactive = !Number.isFinite(lastMs) || now - lastMs > EMPTY_SESSION_TTL_MS;
    if (!inactive) continue;
    const dir = sessionDir(config.dataDir, s.id);
    const bytes = await sessionUsageBytes(join(dir, 'events')).catch(() => 0);
    if (bytes > 0) continue;
    await sessionStore.remove(s.id);
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    removed++;
  }
  return removed;
}

// --- HTTP helpers ------------------------------------------------------------

/**
 * Content-Security-Policy. `style-src` allows inline styles because the gate
 * and legal pages are self-contained (they are served before auth, when the
 * stylesheet behind the token is unreachable). There are no inline scripts
 * anywhere, so script injection stays blocked by `default-src 'self'`.
 */
const CSP =
  "default-src 'self'; img-src 'self' blob:; media-src 'self' blob:; connect-src 'self'; " +
  "style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

/** Defensive response headers, set on every response before the body. */
function applySecurityHeaders(res) {
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function constantTimeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function readCookie(req, name) {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

/**
 * Who is asking. The master token from OWLEYE_TOKEN opens the default session;
 * any other token is looked up as a session id. With no token configured at
 * all the server is open (local-only use) and everything is the default session.
 *
 * @returns {{session: object, token: string, isMaster: boolean} | null}
 */
function resolveAuth(token) {
  if (!config.token) return { session: sessionStore.get(DEFAULT_SESSION), token: '', isMaster: true };
  if (!token) return null;
  if (constantTimeEqual(token, config.token)) return { session: sessionStore.get(DEFAULT_SESSION), token, isMaster: true };
  const session = token !== DEFAULT_SESSION && /^[a-f0-9]{32}$/.test(token) ? sessionStore.get(token) : null;
  if (!session) return null;
  sessionStore.touch(session.id);
  return { session, token, isMaster: false };
}

/** Effective per-session config for adapters: own data dir, own ntfy topic. */
function configFor(session) {
  const own = session.ntfy;
  const isDefault = session.id === DEFAULT_SESSION;
  return {
    ...config,
    dataDir: sessionDir(config.dataDir, session.id),
    ntfy: {
      ...config.ntfy,
      url: own.url || config.ntfy.url,
      // Only the default session inherits the operator's env topic — a new
      // session must never post into somebody else's channel.
      topic: own.topic || (isDefault ? config.ntfy.topic : ''),
      token: own.topic ? own.token : isDefault ? config.ntfy.token : '',
      // A public session may only reach an allowlisted, public origin; the
      // operator's own default session is trusted with its configured server.
      restricted: !isDefault,
    },
  };
}

function sessionView(session) {
  const effective = configFor(session).ntfy;
  return {
    id: session.id,
    isDefault: session.id === DEFAULT_SESSION,
    label: session.label,
    lang: sessionLang(session),
    createdAt: session.createdAt,
    ntfy: { url: effective.url, topic: effective.topic, tokenSet: Boolean(effective.token) },
  };
}

function authOf(req, url) {
  const provided = req.headers['x-owleye-token'] || url.searchParams.get('t') || readCookie(req, 'owleye_token');
  return resolveAuth(provided ? String(provided) : '');
}

function tokenCookie(token) {
  return `owleye_token=${encodeURIComponent(token)}; Path=/; Max-Age=2592000; SameSite=Lax`;
}

/** A browser navigating to a page, as opposed to fetch/curl/the camera client. */
function wantsHtml(req) {
  return (req.method === 'GET' || req.method === 'HEAD') && String(req.headers.accept ?? '').includes('text/html');
}

/**
 * The page a browser sees instead of a bare 401: the brand, one field for the
 * token, a form that posts to /session. Self-contained HTML, because every
 * other asset on this host is behind the token too.
 */
/** UI language for a request: explicit ?lang=, else the browser's Accept-Language. */
function langOf(req, url) {
  const forced = url.searchParams.get('lang');
  if (isLang(forced)) return forced;
  return pickLang(parseAcceptLanguage(req.headers['accept-language']));
}

/** Language a session's server-side texts (notes, notifications) are written in. */
function sessionLang(session) {
  return isLang(session.lang) ? session.lang : 'en';
}

async function sendGate(req, res, status, { error = '' } = {}) {
  const lang = langOf(req, new URL(req.url, 'http://x'));
  const t = translator(lang);
  let html = await readFile(join(config.publicDir, 'gate.html'), 'utf8');
  html = html.replace('{{lang}}', lang).replace(/\{\{([\w.]+)\}\}/g, (_, key) => t(key, { code: '<code>/?t=id</code>' }));
  if (error) html = html.replace('<!--error-->', `<p class="error" role="alert">${t(error)}</p>`);
  html = html.replace(/<!--signup-->([\s\S]*?)<!--\/signup-->/, config.openSignup ? '$1' : '');
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-robots-tag': 'noindex, nofollow',
    'content-length': Buffer.byteLength(html),
  });
  res.end(html);
}

/** POST /session — the gate form. Sets the same cookie ?t= would, without the token in a URL. */
async function handleSession(req, res) {
  if (!config.token) {
    res.writeHead(303, { location: '/' });
    res.end();
    return;
  }
  const { body, tooLarge } = await readBody(req, 4 * 1024);
  const form = new URLSearchParams(tooLarge ? '' : body.toString('utf8'));
  const provided = (form.get('token') ?? '').trim();
  if (resolveAuth(provided)) {
    const mode = form.get('mode') === 'record' ? 'record' : 'view';
    res.writeHead(303, { location: `/?mode=${mode}`, 'set-cookie': tokenCookie(provided) });
    res.end();
    return;
  }
  log(`gate: wrong token from ${req.socket.remoteAddress ?? '?'}`);
  await new Promise((r) => setTimeout(r, 400)); // a small brake on guessing
  await sendGate(req, res, 401, { error: 'gate.err.wrong' });
}

/**
 * POST /signup — the "new session" button on the gate. Only with
 * OWLEYE_OPEN_SIGNUP; a fresh session is empty, so handing one out costs
 * nothing but disk, which the per-IP and total caps bound.
 */
async function handleSignup(req, res) {
  if (!config.openSignup || !config.token) {
    sendJson(res, 404, { ok: false, error: 'self-signup is off — set OWLEYE_OPEN_SIGNUP=1' });
    return;
  }
  const ip = clientIp(req);
  const now = Date.now();
  const recent = (signups.get(ip) ?? []).filter((t) => now - t < SIGNUP_WINDOW_MS);
  if (recent.length >= SIGNUP_PER_IP) {
    await sendGate(req, res, 429, { error: 'gate.err.rate' });
    return;
  }
  // A cross-IP cap so a botnet cannot each open its five and drain the pool.
  signupTimes = signupTimes.filter((t) => now - t < 60_000);
  if (signupTimes.length >= config.signupGlobalPerMinute) {
    await sendGate(req, res, 429, { error: 'gate.err.rate' });
    return;
  }
  if (sessionStore.count() >= config.maxSessions) {
    // Reclaim empty, abandoned sessions before turning anyone away.
    await purgeEmptySessions(now).catch(() => {});
    if (sessionStore.count() >= config.maxSessions) {
      await sendGate(req, res, 503, { error: 'gate.err.full' });
      return;
    }
  }
  await readBody(req, 4 * 1024); // drain the form, nothing in it is used
  recent.push(now);
  signups.set(ip, recent);
  signupTimes.push(now);
  const session = await sessionStore.create();
  await sessionStore.update(session.id, { lang: langOf(req, new URL(req.url, 'http://x')) });
  log(`session created: ${session.id.slice(0, 8)}… from ${ip} (${sessionStore.count()} total)`);
  res.writeHead(303, { location: `/?t=${session.id}&mode=record`, 'set-cookie': tokenCookie(session.id) });
  res.end();
}

/**
 * Buffer a request body with a hard size cap.
 *
 * On overflow the body is drained rather than the socket destroyed: killing the
 * connection mid-upload makes the client see ECONNRESET instead of our 413, and
 * a phone on flaky Wi-Fi would then retry forever.
 *
 * @returns {Promise<{body: Buffer, tooLarge: boolean}>}
 */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        tooLarge = true;
        chunks.length = 0;
        return; // keep draining, discard the payload
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve({ body: Buffer.concat(chunks), tooLarge }));
    req.on('error', reject);
  });
}

async function serveFile(res, filePath, { download = false } = {}) {
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error('not a file');
    const headers = {
      'content-type': MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
      'content-length': info.size,
      'cache-control': 'no-store',
    };
    if (download) headers['content-disposition'] = `attachment; filename="${filePath.split(sep).pop()}"`;
    res.writeHead(200, headers);
    createReadStream(filePath).pipe(res);
  } catch {
    sendJson(res, 404, { ok: false, error: 'not found' });
  }
}

/** Resolve a request path inside a base directory, refusing traversal. */
function safeJoin(baseDir, requestPath) {
  const clean = normalize(decodeURIComponent(requestPath)).replace(/^(\.\.[/\\])+/, '');
  const full = resolve(baseDir, `.${sep}${clean}`);
  if (full !== baseDir && !full.startsWith(baseDir + sep)) return null;
  return full;
}

// --- Event pipeline ----------------------------------------------------------

function publish(sessionId, entry) {
  const feed = feedOf(sessionId);
  feed.unshift(entry);
  if (feed.length > config.feedSize) feed.length = config.feedSize;
  const payload = `data: ${JSON.stringify(entry)}\n\n`;
  const listeners = streamsOf(sessionId);
  for (const res of listeners) {
    try {
      res.write(payload);
    } catch {
      listeners.delete(res);
    }
  }
}

/** Adapters that make sense for this session. Global env channels stay with the owner. */
function adaptersFor(session, effective) {
  return adapters.filter((a) => {
    if (a.name === 'ntfy') return Boolean(effective.ntfy.topic);
    if (a.name === 'telegram' || a.name === 'webhook') return session.id === DEFAULT_SESSION;
    return true;
  });
}

function mediaUrlFor(event) {
  if (!event.media || !adapters.some((a) => a.name === 'file')) return undefined;
  const day = event.at.slice(0, 10);
  return `/media/${[day, `${eventFileBase(event)}.${event.media.ext}`].map(encodeURIComponent).join('/')}`;
}

async function handleEvent(event, session) {
  const effective = configFor(session);
  event.session = session.id;
  event.lang = sessionLang(session);
  // Known before the file adapter writes it, so linking adapters (web push) can use it.
  event.mediaUrl = mediaUrlFor(event);
  const results = await dispatch(adaptersFor(session, effective), event, effective, console);

  const filePath = results.find((r) => r.ok && r.result?.media)?.result.media;
  const entry = {
    id: event.id,
    at: event.at,
    device: event.device,
    kind: event.kind,
    score: event.score,
    frames: event.frames,
    width: event.width,
    height: event.height,
    note: event.note,
    mime: event.media?.mime,
    bytes: event.media?.buffer.length,
    mediaUrl: filePath ? `/media/${relative(join(effective.dataDir, 'events'), filePath).split(sep).map(encodeURIComponent).join('/')}` : null,
    adapters: results.map(({ name, ok, error }) => ({ name, ok, error })),
  };

  publish(session.id, entry);
  const failed = results.filter((r) => !r.ok).map((r) => r.name);
  log(
    `event ${event.kind} session=${session.id.slice(0, 8)} device=${event.device}`,
    typeof event.score === 'number' ? `score=${(event.score * 100).toFixed(1)}%` : '',
    event.media ? `${(event.media.buffer.length / 1024).toFixed(0)}KB` : '',
    failed.length ? `adapters failed: ${failed.join(',')}` : 'delivered',
  );
  return entry;
}

function markSeen(session, device, meta = {}) {
  const key = `${session.id}\0${device}`;
  const known = devices.get(key);
  devices.set(key, { session, device, lastSeen: Date.now(), online: true, meta: { ...known?.meta, ...meta } });
  if (known && known.online === false) {
    handleEvent(
      {
        id: randomUUID().slice(0, 8),
        at: new Date().toISOString(),
        device,
        kind: 'online',
        note: translator(sessionLang(session))('event.online'),
      },
      session,
    ).catch((err) => log('online event failed:', err.message));
  }
}

function devicesOf(sessionId) {
  return [...devices.values()].filter((d) => d.session.id === sessionId);
}

function watchdog() {
  if (!config.offlineAfter) return;
  const deadline = Date.now() - config.offlineAfter * 1000;
  for (const state of devices.values()) {
    if (state.online && state.lastSeen < deadline) {
      state.online = false;
      handleEvent(
        {
          id: randomUUID().slice(0, 8),
          at: new Date().toISOString(),
          device: state.device,
          kind: 'offline',
          note: translator(sessionLang(state.session))('event.offline', { s: config.offlineAfter }),
        },
        state.session,
      ).catch((err) => log('offline event failed:', err.message));
    }
  }
}

// --- Routing -----------------------------------------------------------------

async function router(req, res) {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  const path = url.pathname;

  applySecurityHeaders(res);

  if (path === '/session' && req.method === 'POST') {
    await handleSession(req, res);
    return;
  }
  if (path === '/signup' && req.method === 'POST') {
    await handleSignup(req, res);
    return;
  }

  const auth = authOf(req, url);
  if (!auth) {
    if (wantsHtml(req)) await sendGate(req, res, 401);
    else sendJson(res, 401, { ok: false, error: 'invalid or missing token' });
    return;
  }

  // Remember a valid ?t= so the phone does not need it on every request.
  if (config.token && url.searchParams.get('t')) {
    res.setHeader('set-cookie', tokenCookie(auth.token));
  }

  const session = auth.session;

  if (path === '/api/session' && req.method === 'POST') {
    const { body, tooLarge } = await readBody(req, 8 * 1024);
    let patch;
    try {
      patch = JSON.parse(body.toString('utf8'));
    } catch {
      sendJson(res, tooLarge ? 413 : 400, { ok: false, error: 'body must be JSON' });
      return;
    }
    if (patch.lang !== undefined && !isLang(patch.lang)) {
      sendJson(res, 400, { ok: false, error: 'lang must be one of en, ru, th, sr' });
      return;
    }
    if (patch.ntfy?.url && !/^https?:\/\/[^\s/]+/.test(patch.ntfy.url)) {
      sendJson(res, 400, { ok: false, error: 'ntfy.url must be an http(s) URL' });
      return;
    }
    if (patch.ntfy?.topic && !/^[\w.-]{1,64}$/.test(patch.ntfy.topic)) {
      sendJson(res, 400, { ok: false, error: 'ntfy.topic: letters, digits, _ . - only' });
      return;
    }
    const updated = await sessionStore.update(session.id, patch);
    if (patch.ntfy) log(`session ${session.id.slice(0, 8)} settings updated`);
    sendJson(res, 200, { ok: true, session: sessionView(updated) });
    return;
  }

  if (path === '/api/health') {
    sendJson(res, 200, {
      ok: true,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      devices: devicesOf(session.id).map((d) => ({
        name: d.device,
        online: d.online,
        lastSeen: new Date(d.lastSeen).toISOString(),
      })),
    });
    return;
  }

  if (path === '/api/config') {
    sendJson(res, 200, {
      ok: true,
      adapters: adapters.map((a) => a.name),
      offlineAfter: config.offlineAfter,
      maxUploadBytes: config.maxUploadBytes,
      secure: req.socket.encrypted === true,
      pushPublicKey: pushStore()?.vapid.publicKey ?? null,
      openSignup: Boolean(config.openSignup && config.token),
      token: auth.token,
      session: sessionView(session),
    });
    return;
  }

  if (path.startsWith('/api/push/')) {
    const store = pushStore();
    if (!store) {
      sendJson(res, 404, { ok: false, error: 'webpush adapter is not enabled — add it to OWLEYE_ADAPTERS' });
      return;
    }
    if (path === '/api/push/vapid' && req.method === 'GET') {
      sendJson(res, 200, { ok: true, publicKey: store.vapid.publicKey, subscriptions: store.count(session.id) });
      return;
    }
    if ((path === '/api/push/subscribe' || path === '/api/push/unsubscribe') && req.method === 'POST') {
      const { body, tooLarge } = await readBody(req, 16 * 1024);
      let payload;
      try {
        payload = JSON.parse(body.toString('utf8'));
      } catch {
        sendJson(res, tooLarge ? 413 : 400, { ok: false, error: 'body must be JSON' });
        return;
      }
      try {
        if (path === '/api/push/subscribe') {
          const sub = await store.add(payload.subscription ?? payload, payload.label ?? '', auth.token, session.id);
          log(`push subscription added (${store.count(session.id)} in session) — ${String(payload.label ?? '').slice(0, 60)}`);
          sendJson(res, 200, { ok: true, endpoint: sub.endpoint, subscriptions: store.count(session.id) });
        } else {
          const removed = await store.remove(String(payload.endpoint ?? ''), session.id);
          if (removed) log(`push subscription removed (${store.count(session.id)} left in session)`);
          sendJson(res, 200, { ok: true, removed, subscriptions: store.count(session.id) });
        }
      } catch (err) {
        sendJson(res, 400, { ok: false, error: err.message });
      }
      return;
    }
  }

  if (path === '/api/events' && req.method === 'GET') {
    const limit = Math.min(Number(url.searchParams.get('limit')) || 50, config.feedSize);
    sendJson(res, 200, { ok: true, events: feedOf(session.id).slice(0, limit) });
    return;
  }

  if (path === '/api/stream') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    });
    res.write(`retry: 3000\n\n`);
    const listeners = streamsOf(session.id);
    listeners.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => {
      clearInterval(ping);
      listeners.delete(res);
    });
    return;
  }

  if (path === '/api/heartbeat' && req.method === 'POST') {
    const { body } = await readBody(req, 64 * 1024);
    let meta = {};
    try {
      meta = JSON.parse(body.toString('utf8') || '{}');
    } catch {
      /* tolerate junk */
    }
    markSeen(session, String(meta.device || 'camera'), meta);
    sendJson(res, 200, { ok: true, serverTime: new Date().toISOString() });
    return;
  }

  if (path === '/api/event' && req.method === 'POST') {
    const limit = rateLimitEvent(session.id);
    if (!limit.ok) {
      res.setHeader('retry-after', String(limit.retryAfter));
      sendJson(res, 429, { ok: false, error: `too many events — retry in ${limit.retryAfter}s` });
      return;
    }

    const { body, tooLarge } = await readBody(req, config.maxUploadBytes);
    if (tooLarge) {
      sendJson(res, 413, {
        ok: false,
        error: `payload exceeds ${config.maxUploadBytes} bytes — lower the clip length, resolution or FPS`,
      });
      return;
    }

    let meta = {};
    const rawMeta = req.headers['x-owleye-meta'];
    if (rawMeta) {
      try {
        meta = JSON.parse(Buffer.from(String(rawMeta), 'base64').toString('utf8'));
      } catch {
        sendJson(res, 400, { ok: false, error: 'x-owleye-meta is not base64 JSON' });
        return;
      }
    }

    // A client-supplied timestamp becomes part of the storage path, so it is
    // validated to a canonical ISO string here — never used raw.
    const at = normalizeAt(meta.at);
    if (at.error) {
      sendJson(res, 400, { ok: false, error: at.error });
      return;
    }

    const mime = String(req.headers['content-type'] || 'application/octet-stream').split(';')[0];
    const device = String(meta.device || 'camera').replace(/[^\w.-]+/g, '_').slice(0, 40) || 'camera';
    markSeen(session, device, { userAgent: req.headers['user-agent'] });

    const event = {
      id: randomUUID().slice(0, 8),
      at: at.at,
      device,
      kind: meta.kind === 'test' ? 'test' : 'motion',
      score: typeof meta.score === 'number' ? meta.score : undefined,
      frames: meta.frames,
      width: meta.width,
      height: meta.height,
      note: typeof meta.note === 'string' ? meta.note.slice(0, 300) : undefined,
      media: body.length
        ? { buffer: body, mime, ext: mime === 'image/gif' ? 'gif' : mime === 'image/jpeg' ? 'jpg' : 'bin' }
        : undefined,
    };

    // Quota enforcement and the write are serialized per session so two
    // uploads racing cannot both slip past the budget. Roughly 4 KiB is
    // reserved for the JSON sidecar the file adapter writes alongside the clip.
    const outcome = await withSessionLock(session.id, async () => {
      const fileActive = adapters.some((a) => a.name === 'file');
      if (fileActive && event.media) {
        const eventsDir = join(sessionDir(config.dataDir, session.id), 'events');
        const incoming = event.media.buffer.length + 4096;
        await pruneExpired(eventsDir, config.retentionSeconds * 1000, Date.now(), console).catch(() => {});
        const used = await sessionUsageBytes(eventsDir);
        if (used + incoming > config.sessionMaxBytes) {
          const { fits } = await evictToFit(eventsDir, config.sessionMaxBytes, incoming, console);
          if (!fits) return { insufficient: true };
        }
      }
      return { entry: await handleEvent(event, session) };
    });

    if (outcome.insufficient) {
      sendJson(res, 507, { ok: false, error: 'session storage is full and cannot be freed for this event' });
      return;
    }
    sendJson(res, 200, { ok: true, event: outcome.entry });
    return;
  }

  if (path === '/api/test' && req.method === 'POST') {
    const entry = await handleEvent(
      {
        id: randomUUID().slice(0, 8),
        at: new Date().toISOString(),
        device: 'owleye-server',
        kind: 'test',
        note: translator(sessionLang(session))('event.test'),
      },
      session,
    );
    sendJson(res, 200, { ok: true, event: entry });
    return;
  }

  // Served dynamically so the home-screen app on a phone opens with the token:
  // iOS keeps separate cookies for a standalone web app, and the manifest is
  // only reachable by a client that already holds the token anyway.
  if (path === '/manifest.webmanifest') {
    const start = auth.token ? `/?t=${encodeURIComponent(auth.token)}` : '/';
    const manifest = {
      name: 'owleye',
      short_name: 'owleye',
      description: 'Motion-triggered camera alerts',
      start_url: start,
      scope: '/',
      display: 'standalone',
      background_color: '#0a0d12',
      theme_color: '#0a0d12',
      icons: [
        { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
      ],
    };
    const payload = JSON.stringify(manifest);
    res.writeHead(200, {
      'content-type': 'application/manifest+json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(payload),
    });
    res.end(payload);
    return;
  }

  if (path.startsWith('/media/')) {
    const file = safeJoin(join(sessionDir(config.dataDir, session.id), 'events'), path.slice('/media/'.length));
    if (!file) {
      sendJson(res, 400, { ok: false, error: 'bad path' });
      return;
    }
    await serveFile(res, file, { download: url.searchParams.has('download') });
    return;
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    const rel = path === '/' ? 'index.html' : path;
    const file = safeJoin(config.publicDir, rel);
    if (!file) {
      sendJson(res, 400, { ok: false, error: 'bad path' });
      return;
    }
    await serveFile(res, file);
    return;
  }

  sendJson(res, 404, { ok: false, error: 'not found' });
}

// --- Keep the Mac awake ------------------------------------------------------

/**
 * `caffeinate` is the supported macOS way to assert power assertions:
 *   -d prevent display sleep, -i prevent idle sleep,
 *   -m prevent disk sleep, -s prevent system sleep on AC,
 *   -w <pid> live exactly as long as this process.
 */
function startCaffeinate() {
  if (process.platform !== 'darwin' || !config.caffeinate) return null;
  try {
    const child = spawn('caffeinate', ['-dims', '-w', String(process.pid)], { stdio: 'ignore', detached: false });
    child.on('error', () => log('caffeinate unavailable, the Mac may sleep'));
    return child;
  } catch {
    log('caffeinate unavailable, the Mac may sleep');
    return null;
  }
}

// --- Bootstrap ---------------------------------------------------------------

async function main() {
  await mkdir(config.dataDir, { recursive: true });
  sessionStore = await openSessionStore(config.dataDir);
  if (sessionStore.count()) log(`${sessionStore.count()} session(s) loaded from ${sessionStore.file}`);

  const init = await initAdapters(config, console);
  adapters = init.active;

  // Enforce retention and per-session budgets at startup, then on a timer.
  await cleanupStorage().catch((err) => log(`initial cleanup failed: ${err.message}`));

  let server;
  let scheme = 'http';
  if (config.https) {
    const cert = ensureCertificate(config.certDir, { tlsKey: config.tlsKey, tlsCert: config.tlsCert });
    if (cert.generated) log(`generated a self-signed certificate: ${cert.path}`);
    if (cert.provided) log(`using the supplied certificate: ${cert.path}`);
    server = createHttpsServer({ key: cert.key, cert: cert.cert }, (req, res) => {
      router(req, res).catch((err) => {
        log('request failed:', err.message);
        if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'internal error' });
      });
    });
    scheme = 'https';
  } else {
    server = createHttpServer((req, res) => {
      router(req, res).catch((err) => {
        log('request failed:', err.message);
        if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'internal error' });
      });
    });
  }

  server.listen(config.port, config.host, () => {
    const suffix = config.token ? `?t=${config.token}` : '';
    console.log('');
    console.log('  owleye is watching');
    console.log('');
    console.log(`  local     ${scheme}://localhost:${config.port}/${suffix}`);
    for (const ip of localAddresses()) {
      console.log(`  network   ${scheme}://${ip}:${config.port}/${suffix}`);
    }
    if (!config.https) {
      console.log('');
      console.log('  note: phones need --https — the camera API is blocked on a plain-HTTP LAN address');
    }
    console.log('');
    for (const item of init.report) {
      console.log(`  adapter   ${item.name.padEnd(9)} ${item.status}${item.detail ? ` — ${item.detail}` : ''}`);
    }
    console.log('');
    console.log(`  events    ${join(config.dataDir, 'events')}`);
    if (config.token) console.log('  token     required (x-owleye-token header, ?t= query, or cookie)');
    if (config.token) console.log(`  signup    ${config.openSignup ? 'OPEN — anyone can create a session from the gate page' : 'off (OWLEYE_OPEN_SIGNUP=1 to allow)'}`);
    console.log('');
  });

  const caffeine = startCaffeinate();
  if (caffeine) log('caffeinate active: this Mac will not sleep while owleye runs');

  const watchdogTimer = setInterval(watchdog, 15000);
  const cleanupTimer = setInterval(() => {
    cleanupStorage().catch((err) => log(`cleanup failed: ${err.message}`));
  }, CLEANUP_INTERVAL_MS);
  cleanupTimer.unref();

  const shutdown = (signal) => {
    log(`${signal} received, shutting down`);
    clearInterval(watchdogTimer);
    clearInterval(cleanupTimer);
    caffeine?.kill();
    for (const listeners of streams.values()) for (const res of listeners) res.end();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('owleye failed to start:', err);
  process.exit(1);
});
