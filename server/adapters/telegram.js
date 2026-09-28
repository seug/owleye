/**
 * Telegram adapter.
 *
 * Bot API reference: https://core.telegram.org/bots/api
 *  - GIF  -> sendAnimation (Telegram transcodes it to a looping MP4)
 *  - JPEG -> sendPhoto
 *  - no media (offline alert etc.) -> sendMessage
 *
 * Uses global fetch/FormData/Blob (Node >= 18), so no dependencies.
 *
 * Setup: talk to @BotFather to create a bot and get TELEGRAM_BOT_TOKEN, then
 * message your bot once and read the chat id from
 * https://api.telegram.org/bot<TOKEN>/getUpdates into TELEGRAM_CHAT_ID.
 */

const TIMEOUT_MS = 25000;

import { INTL_LOCALE, translator } from '../../public/lib/i18n.js';

export default {
  name: 'telegram',

  isEnabled(config) {
    return Boolean(config.telegram.token && config.telegram.chatId);
  },

  describe(config) {
    return `chat ${config.telegram.chatId}`;
  },

  async init(config) {
    const me = await call(config, 'getMe', null, 'GET');
    if (!me.ok) throw new Error(`getMe failed: ${me.description ?? 'unknown error'}`);
    return `bot @${me.result?.username ?? '?'}`;
  },

  async send(event, config) {
    const caption = buildCaption(event);
    const form = new FormData();
    form.set('chat_id', config.telegram.chatId);
    if (config.telegram.silent) form.set('disable_notification', 'true');

    let method;
    if (!event.media) {
      method = 'sendMessage';
      form.set('text', caption);
    } else if (event.media.mime === 'image/gif') {
      method = 'sendAnimation';
      form.set('caption', caption);
      form.set('animation', toBlob(event.media), `owleye-${event.id}.gif`);
      if (event.width) form.set('width', String(event.width));
      if (event.height) form.set('height', String(event.height));
    } else {
      method = 'sendPhoto';
      form.set('caption', caption);
      form.set('photo', toBlob(event.media), `owleye-${event.id}.${event.media.ext}`);
    }

    const res = await call(config, method, form);
    if (!res.ok) throw new Error(`${method} failed: ${res.description ?? 'unknown error'}`);
    return { messageId: res.result?.message_id };
  },
};

function toBlob(media) {
  return new Blob([media.buffer], { type: media.mime });
}

function buildCaption(event) {
  const time = new Date(event.at).toLocaleString(INTL_LOCALE[event.lang] ?? 'en-GB', { hour12: false });
  const lines = [];
  const t = translator(event.lang);
  const icon = { motion: '👁', offline: '⚠️', online: '✅', test: '🔧' }[event.kind] ?? '•';
  const key = ['motion', 'offline', 'online', 'test'].includes(event.kind) ? `notify.${event.kind}` : 'notify.other';
  lines.push(`${icon} ${t(key, { kind: event.kind, device: event.device })}`);

  lines.push(time);
  if (typeof event.score === 'number') lines.push(t('notify.intensity', { pct: (event.score * 100).toFixed(1) }));
  if (event.note) lines.push(event.note);
  return lines.join('\n').slice(0, 1024);
}

async function call(config, method, form, httpMethod = 'POST') {
  const url = `https://api.telegram.org/bot${config.telegram.token}/${method}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: httpMethod,
      body: form ?? undefined,
      signal: controller.signal,
    });
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}
