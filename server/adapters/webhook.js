/**
 * Generic webhook adapter — the escape hatch for anything that is not Telegram.
 *
 * Posts the raw media bytes with the metadata in headers, so the receiver can
 * stream it straight to disk or to another chat system:
 *
 *   POST <OWLEYE_WEBHOOK_URL>
 *   content-type: image/gif
 *   x-owleye-event: <base64 JSON metadata>
 *   x-owleye-secret: <OWLEYE_WEBHOOK_SECRET, if set>
 *
 * Events without media are posted as application/json.
 */

const TIMEOUT_MS = 15000;

export default {
  name: 'webhook',

  isEnabled(config) {
    return Boolean(config.webhook.url);
  },

  describe(config) {
    return config.webhook.url.replace(/\/\/[^@]*@/, '//***@');
  },

  async send(event, config) {
    const meta = { ...event, media: undefined };
    const headers = {
      'x-owleye-event': Buffer.from(JSON.stringify(meta), 'utf8').toString('base64'),
    };
    if (config.webhook.secret) headers['x-owleye-secret'] = config.webhook.secret;

    let body;
    if (event.media) {
      headers['content-type'] = event.media.mime;
      body = event.media.buffer;
    } else {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(meta);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(config.webhook.url, { method: 'POST', headers, body, signal: controller.signal });
      if (!res.ok) throw new Error(`webhook responded ${res.status}`);
      return { status: res.status };
    } finally {
      clearTimeout(timer);
    }
  },
};
