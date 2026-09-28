/**
 * ntfy adapter — https://ntfy.sh (or any self-hosted ntfy server).
 *
 * One HTTP request per event: PUT <url>/<topic> with the clip as the body and
 * the text in headers. The phone app (Android / iOS) subscribed to the topic
 * shows the notification with the GIF attached. ntfy.sh keeps attachments up
 * to 15 MB for three hours; the clip also stays on disk via the file adapter.
 *
 * The topic name is the only secret on the public server: pick a long random
 * one (NTFY_TOPIC). NTFY_TOKEN is for reserved topics or a self-hosted server
 * with auth. Non-ASCII header values are sent RFC 2047-encoded, which ntfy
 * understands.
 */

const TIMEOUT_MS = 25000;
const MAX_ATTACHMENT = 15 * 1024 * 1024;

import { INTL_LOCALE, translator } from '../../public/lib/i18n.js';
import { safeFetch } from '../net-guard.js';

const TAGS = { motion: 'eye', offline: 'warning', online: 'white_check_mark', test: 'wrench' };

export default {
  name: 'ntfy',

  // Topics are per session (set in the web UI); NTFY_TOPIC only seeds the
  // default session, so the adapter is on whenever it is listed.
  isEnabled() {
    return true;
  },

  describe(config) {
    return config.ntfy.topic ? `${config.ntfy.url}/${maskTopic(config.ntfy.topic)}` : `${config.ntfy.url}, topics per session`;
  },

  async init(config) {
    const res = await request(config, `${config.ntfy.url}/v1/health`, { method: 'GET' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.healthy !== true) throw new Error(`${config.ntfy.url}/v1/health responded ${res.status}`);
    return this.describe(config);
  },

  async send(event, config) {
    const headers = {
      title: encodeHeader(title(event)),
      tags: TAGS[event.kind] ?? 'bell',
      priority: event.kind === 'motion' || event.kind === 'offline' ? config.ntfy.priority : 'default',
    };
    if (config.ntfy.token) headers.authorization = `Bearer ${config.ntfy.token}`;

    let body;
    const attach = event.media && event.media.buffer.length <= MAX_ATTACHMENT;
    if (attach) {
      headers.filename = `owleye-${event.id}.${event.media.ext}`;
      headers.message = encodeHeader(message(event));
      headers['content-type'] = event.media.mime;
      body = event.media.buffer;
    } else {
      const note = event.media ? `\n${translator(event.lang)('notify.clipTooBig', { mb: Math.round(event.media.buffer.length / 1048576) })}` : '';
      body = Buffer.from(message(event) + note, 'utf8');
    }

    // A public (non-default) session may only reach an allowlisted origin, and
    // never a private / loopback address; the operator's own default session
    // is trusted with whatever NTFY_URL points at.
    const guard = {
      allowedOrigins: config.ntfy.restricted ? config.ntfy.allowedOrigins : null,
      allowLoopbackHttp: config.devAllowInsecureOutbound === true,
      timeoutMs: TIMEOUT_MS,
    };
    const res = await safeFetch(
      `${config.ntfy.url}/${encodeURIComponent(config.ntfy.topic)}`,
      { method: attach ? 'PUT' : 'POST', headers, body },
      guard,
    );
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`ntfy responded ${res.status}${json.error ? `: ${json.error}` : ''}`);
    return { id: json.id, attached: Boolean(attach) };
  },
};

function title(event) {
  const t = translator(event.lang);
  const key = ['motion', 'offline', 'online', 'test'].includes(event.kind) ? `notify.${event.kind}` : 'notify.other';
  return t(key, { kind: event.kind, device: event.device });
}

function message(event) {
  const t = translator(event.lang);
  const lines = [new Date(event.at).toLocaleString(INTL_LOCALE[event.lang] ?? 'en-GB', { hour12: false })];
  if (typeof event.score === 'number') lines.push(t('notify.intensity', { pct: (event.score * 100).toFixed(1) }));
  if (event.note) lines.push(event.note);
  return lines.join('\n');
}

/** HTTP headers are ASCII; RFC 2047 encoded-words carry the Cyrillic through. */
function encodeHeader(text) {
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7e]*$/.test(text)) return text;
  return `=?UTF-8?B?${Buffer.from(text, 'utf8').toString('base64')}?=`;
}

function maskTopic(topic) {
  return topic.length <= 4 ? '****' : `****${topic.slice(-4)}`;
}

async function request(config, url, { method, headers = {}, body }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { method, headers, body, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
