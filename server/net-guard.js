/**
 * Guards for server-initiated ("outbound") HTTP requests.
 *
 * An anonymous session can hand the server a URL to call — an ntfy server, a
 * Web Push endpoint. Without checks that URL could point at the metadata
 * service, a database on the LAN, or localhost: a classic SSRF. These helpers
 * refuse non-HTTPS, credentials in the URL, and any host that resolves to a
 * loopback / private / link-local / multicast / reserved address, and they
 * re-check every hop of a redirect instead of trusting `fetch` to follow it.
 *
 * No dependencies: DNS via node:dns, address classification by hand.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const MAX_URL_LENGTH = 2048;
const MAX_REDIRECTS = 3;
const DEFAULT_TIMEOUT_MS = 20000;

/** Parse "a.b.c.d" into four octets, or null. */
function ipv4Octets(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return octets;
}

/** True for an IPv4 address that must never be reached from a public session. */
function isForbiddenIpv4(ip) {
  const o = ipv4Octets(ip);
  if (!o) return true; // unparseable — refuse
  const [a, b] = o;
  if (a === 0) return true; // 0.0.0.0/8 "this host"
  if (a === 10) return true; // private
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a === 192 && b === 0) return true; // 192.0.0/24 and 192.0.2/24 special-use
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking 198.18/15
  if (a === 198 && b === 51) return true; // 198.51.100/24 TEST-NET-2
  if (a === 203 && b === 0) return true; // 203.0.113/24 TEST-NET-3
  if (a >= 224) return true; // 224/4 multicast + 240/4 reserved + 255 broadcast
  return false;
}

/** True for an IPv6 address that must never be reached from a public session. */
function isForbiddenIpv6(raw) {
  let ip = raw.toLowerCase();
  const zone = ip.indexOf('%');
  if (zone >= 0) ip = ip.slice(0, zone); // drop scope id

  // IPv4-mapped / -compatible (::ffff:1.2.3.4, ::1.2.3.4) — judge the v4 part.
  const tail = ip.slice(ip.lastIndexOf(':') + 1);
  if (tail.includes('.')) return isForbiddenIpv4(tail);

  if (ip === '::1' || ip === '::') return true; // loopback / unspecified
  if (ip.startsWith('fe8') || ip.startsWith('fe9') || ip.startsWith('fea') || ip.startsWith('feb')) return true; // fe80::/10 link-local
  if (ip.startsWith('fc') || ip.startsWith('fd')) return true; // fc00::/7 unique-local
  if (ip.startsWith('ff')) return true; // ff00::/8 multicast
  return false;
}

export function isForbiddenIp(ip) {
  const kind = isIP(ip);
  if (kind === 4) return isForbiddenIpv4(ip);
  if (kind === 6) return isForbiddenIpv6(ip);
  return true; // not an IP literal — refuse
}

/**
 * Validate a URL string before it is used as an outbound target.
 *
 * @param {string} raw
 * @param {{ allowedOrigins?: string[]|null, allowLoopbackHttp?: boolean }} [opts]
 * @returns {URL}
 * @throws if the URL is not a safe outbound target
 */
export function assertSafeUrl(raw, { allowedOrigins = null, allowLoopbackHttp = false } = {}) {
  if (typeof raw !== 'string' || raw.length === 0) throw new Error('outbound URL is empty');
  if (raw.length > MAX_URL_LENGTH) throw new Error('outbound URL is too long');

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('outbound URL is not a valid URL');
  }

  if (url.username || url.password) throw new Error('outbound URL must not contain credentials');

  const isHttps = url.protocol === 'https:';
  const isLoopbackHttp =
    url.protocol === 'http:' &&
    (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]' || url.hostname === '::1');
  if (!isHttps && !(allowLoopbackHttp && isLoopbackHttp)) {
    throw new Error('outbound URL must use HTTPS');
  }

  if (allowedOrigins && allowedOrigins.length) {
    if (!allowedOrigins.includes(url.origin)) {
      throw new Error(`outbound origin ${url.origin} is not in the allowlist`);
    }
  }
  return url;
}

/**
 * Resolve a hostname and confirm every address it maps to is publicly
 * routable. An IP literal is checked directly. Called immediately before the
 * connection so a rebinding record does not slip a private address through a
 * later lookup.
 *
 * @param {string} hostname
 * @param {{ allowLoopback?: boolean }} [opts]
 */
export async function assertHostResolvesPublic(hostname, { allowLoopback = false } = {}) {
  const bare = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;

  if (isIP(bare)) {
    if (allowLoopback && (bare === '127.0.0.1' || bare === '::1')) return;
    if (isForbiddenIp(bare)) throw new Error(`outbound host ${hostname} resolves to a non-public address`);
    return;
  }

  if (allowLoopback && bare === 'localhost') return;

  let records;
  try {
    records = await lookup(bare, { all: true });
  } catch {
    throw new Error(`outbound host ${hostname} does not resolve`);
  }
  if (!records.length) throw new Error(`outbound host ${hostname} does not resolve`);
  for (const { address } of records) {
    if (isForbiddenIp(address)) throw new Error(`outbound host ${hostname} resolves to a non-public address`);
  }
}

/**
 * fetch() with SSRF guards. Redirects are followed manually so each hop is
 * re-validated against the same rules; a redirect that leaves the allowlist,
 * changes origin (when sameOriginOnly), or points at a private address fails.
 *
 * @param {string} rawUrl
 * @param {object} fetchOptions  passed to fetch (method, headers, body, signal…)
 * @param {{ allowedOrigins?: string[]|null, allowLoopbackHttp?: boolean, sameOriginOnly?: boolean, timeoutMs?: number }} [guard]
 */
export async function safeFetch(rawUrl, fetchOptions = {}, guard = {}) {
  const { allowedOrigins = null, allowLoopbackHttp = false, sameOriginOnly = false, timeoutMs = DEFAULT_TIMEOUT_MS } = guard;

  let currentUrl = rawUrl;
  let originalOrigin = null;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const url = assertSafeUrl(currentUrl, { allowedOrigins, allowLoopbackHttp });
    if (originalOrigin === null) originalOrigin = url.origin;
    else if (sameOriginOnly && url.origin !== originalOrigin) {
      throw new Error('outbound redirect changed origin');
    }
    await assertHostResolvesPublic(url.hostname, { allowLoopback: allowLoopbackHttp });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(url, { ...fetchOptions, redirect: 'manual', signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }

    // undici surfaces a followed/blocked redirect as an opaqueredirect or a 3xx
    // with a Location header. Handle the manual 3xx case ourselves.
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      if (hop === MAX_REDIRECTS) throw new Error('outbound request exceeded the redirect limit');
      currentUrl = new URL(res.headers.get('location'), url).toString();
      continue;
    }
    return res;
  }
  throw new Error('outbound request exceeded the redirect limit');
}
