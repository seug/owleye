/**
 * Configuration: environment variables, optionally seeded from a .env file,
 * overridable by a few CLI flags. No dependencies.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Minimal .env reader: KEY=value, # comments, optional quotes. Never overrides a real env var. */
export function loadDotEnv(file = resolve(ROOT, '.env')) {
  if (!existsSync(file)) return;
  for (const rawLine of readFileSync(file, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

function bool(value, fallback = false) {
  if (value === undefined || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value));
}

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Origin (scheme://host[:port]) of a URL, or null if it does not parse. */
function originOf(raw) {
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

/** The ntfy origins a public session is allowed to reach. */
function ntfyAllowedOrigins() {
  const origins = new Set(['https://ntfy.sh']);
  const own = originOf(process.env.NTFY_URL ?? '');
  if (own) origins.add(own);
  for (const raw of (process.env.OWLEYE_NTFY_ALLOWED_ORIGINS ?? '').split(',')) {
    const origin = originOf(raw.trim());
    if (origin) origins.add(origin);
  }
  return [...origins];
}

export function loadConfig(argv = process.argv.slice(2)) {
  loadDotEnv();

  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const flagValue = (name) => {
    const withEq = argv.find((a) => a.startsWith(`--${name}=`));
    if (withEq) return withEq.slice(name.length + 3);
    const i = argv.indexOf(`--${name}`);
    if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
    return undefined;
  };

  const adapters = (flagValue('adapters') ?? process.env.OWLEYE_ADAPTERS ?? 'file')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  return {
    port: num(flagValue('port') ?? process.env.OWLEYE_PORT, 8443),
    host: flagValue('host') ?? process.env.OWLEYE_HOST ?? '0.0.0.0',
    https: flags.has('--https') || bool(process.env.OWLEYE_HTTPS, false),
    dataDir: resolve(flagValue('data') ?? process.env.OWLEYE_DATA_DIR ?? resolve(ROOT, 'data')),
    publicDir: resolve(ROOT, 'public'),
    certDir: resolve(process.env.OWLEYE_CERT_DIR ?? resolve(ROOT, 'certs')),

    /**
     * Real certificate (Let's Encrypt and friends). When both are set they are
     * used as-is; otherwise a self-signed pair is generated, which is fine on a
     * LAN but shows a warning screen on a public hostname.
     */
    tlsKey: process.env.OWLEYE_TLS_KEY ?? '',
    tlsCert: process.env.OWLEYE_TLS_CERT ?? '',

    /** Shared secret. Empty string disables auth (local-only use). */
    token: flagValue('token') ?? process.env.OWLEYE_TOKEN ?? '',

    /**
     * Let anyone on the gate page create their own (empty, isolated) session.
     * Meant for trials; off by default.
     */
    openSignup: flags.has('--open-signup') || bool(process.env.OWLEYE_OPEN_SIGNUP, false),
    maxSessions: num(process.env.OWLEYE_MAX_SESSIONS, 500),

    /**
     * How many reverse proxies sit in front of owleye. 0 means owleye is
     * exposed directly and the socket address is the client. With 1 (a single
     * Caddy/nginx on loopback) the client IP is read from X-Forwarded-For,
     * counting from the right so a client cannot spoof its own address.
     */
    trustedProxies: num(process.env.OWLEYE_TRUSTED_PROXIES, 0),

    /** A cap on session creation across all IPs, to blunt a distributed flood. */
    signupGlobalPerMinute: num(process.env.OWLEYE_SIGNUP_GLOBAL_PER_MINUTE, 20),

    adapters,

    /** Reject a single upload larger than this (bytes). */
    maxUploadBytes: num(process.env.OWLEYE_MAX_UPLOAD, 1024 * 1024),

    /** Total on-disk budget for one session's clips + metadata (bytes). */
    sessionMaxBytes: num(process.env.OWLEYE_SESSION_MAX_BYTES, 10 * 1024 * 1024),

    /** Delete an event this many seconds after it was stored. */
    retentionSeconds: num(process.env.OWLEYE_RETENTION_SECONDS, 24 * 60 * 60),

    /** Cap on POST /api/event per session, per minute. */
    eventRatePerMinute: num(process.env.OWLEYE_EVENT_RATE_PER_MINUTE, 30),

    /**
     * Allow non-HTTPS / loopback outbound targets (ntfy, Web Push). Off in
     * production; only for a local dev server talking to a mock on localhost.
     */
    devAllowInsecureOutbound: bool(process.env.OWLEYE_DEV_ALLOW_INSECURE_OUTBOUND, false),

    /** Keep the Mac awake with `caffeinate` while the server runs. */
    caffeinate: !flags.has('--no-caffeinate') && !bool(process.env.OWLEYE_NO_CAFFEINATE, false),

    /** Alert when a camera that was reporting goes quiet, in seconds. 0 disables. */
    offlineAfter: num(process.env.OWLEYE_OFFLINE_AFTER, 120),

    /** How many events to keep in the in-memory feed. */
    feedSize: num(process.env.OWLEYE_FEED_SIZE, 200),

    telegram: {
      token: process.env.TELEGRAM_BOT_TOKEN ?? '',
      chatId: process.env.TELEGRAM_CHAT_ID ?? '',
      silent: bool(process.env.TELEGRAM_SILENT, false),
    },

    webhook: {
      url: process.env.OWLEYE_WEBHOOK_URL ?? '',
      secret: process.env.OWLEYE_WEBHOOK_SECRET ?? '',
    },

    /** ntfy: any server that speaks the ntfy publish API, ntfy.sh by default. */
    ntfy: {
      url: (process.env.NTFY_URL ?? 'https://ntfy.sh').replace(/\/+$/, ''),
      topic: process.env.NTFY_TOPIC ?? '',
      token: process.env.NTFY_TOKEN ?? '',
      priority: process.env.NTFY_PRIORITY ?? 'high',
      /**
       * Origins a public (non-default) session may post to. Always includes
       * https://ntfy.sh and the operator's own NTFY_URL; extend with a
       * comma-separated OWLEYE_NTFY_ALLOWED_ORIGINS.
       */
      allowedOrigins: ntfyAllowedOrigins(),
    },

    /**
     * Web Push. The VAPID pair is generated once and cached under
     * <dataDir>/webpush/ unless both keys are supplied here. `subject` is what
     * the push services see as the sender — a mailto: or https: URL.
     */
    webpush: {
      publicKey: process.env.WEBPUSH_VAPID_PUBLIC ?? '',
      privateKey: process.env.WEBPUSH_VAPID_PRIVATE ?? '',
      subject: process.env.WEBPUSH_SUBJECT ?? 'mailto:owleye@example.com',
      ttl: num(process.env.WEBPUSH_TTL, 3600),
      /** Cap on push subscriptions one session may register. */
      maxSubsPerSession: num(process.env.WEBPUSH_MAX_SUBS_PER_SESSION, 20),
    },
  };
}
