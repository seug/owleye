/**
 * Adapter registry and fan-out.
 *
 * An adapter is a plain object:
 *   {
 *     name: string,
 *     isEnabled(config): boolean,          // optional, default true
 *     describe(config): string,            // optional, shown at startup
 *     async init(config): string|void,     // optional, may throw to disable itself
 *     async send(event, config): any,      // required
 *   }
 *
 * `event` is:
 *   { id, at (ISO), device, kind: 'motion'|'offline'|'online'|'test',
 *     score?, frames?, width?, height?, note?,
 *     media?: { buffer: Buffer, mime: string, ext: string } }
 *
 * To add one: drop a module in this folder, import it below, and switch it on
 * with OWLEYE_ADAPTERS=file,telegram,yours.
 *
 * `event.mediaUrl` (the /media/... path the clip will have on this server) is
 * set by the server before dispatch whenever the file adapter is on, so
 * adapters that link to the clip instead of attaching it can use it.
 */
import fileAdapter from './file.js';
import telegramAdapter from './telegram.js';
import webhookAdapter from './webhook.js';
import consoleAdapter from './console.js';
import ntfyAdapter from './ntfy.js';
import webpushAdapter from './webpush.js';

const AVAILABLE = [fileAdapter, telegramAdapter, webhookAdapter, consoleAdapter, ntfyAdapter, webpushAdapter];

export function listAvailable() {
  return AVAILABLE.map((a) => a.name);
}

/** Resolve names from config into initialised adapters, reporting what happened. */
export async function initAdapters(config, log = console) {
  const active = [];
  const report = [];

  for (const name of config.adapters) {
    const adapter = AVAILABLE.find((a) => a.name === name);
    if (!adapter) {
      report.push({ name, status: 'unknown', detail: `available: ${listAvailable().join(', ')}` });
      continue;
    }
    if (adapter.isEnabled && !adapter.isEnabled(config)) {
      report.push({ name, status: 'not configured', detail: missingHint(name) });
      continue;
    }
    try {
      const detail = adapter.init ? await adapter.init(config) : undefined;
      active.push(adapter);
      report.push({
        name,
        status: 'active',
        detail: detail || (adapter.describe ? adapter.describe(config) : ''),
      });
    } catch (err) {
      report.push({ name, status: 'failed', detail: err.message });
      log.error?.(`[adapter:${name}] init failed: ${err.message}`);
    }
  }

  return { active, report };
}

/** Deliver one event to every active adapter. One failure never blocks the others. */
export async function dispatch(adapters, event, config, log = console) {
  const settled = await Promise.allSettled(
    adapters.map(async (adapter) => ({ name: adapter.name, result: await adapter.send(event, config) })),
  );

  return settled.map((outcome, i) => {
    const name = adapters[i].name;
    if (outcome.status === 'fulfilled') return { name, ok: true, result: outcome.value.result };
    log.error?.(`[adapter:${name}] ${outcome.reason?.message ?? outcome.reason}`);
    return { name, ok: false, error: String(outcome.reason?.message ?? outcome.reason) };
  });
}

function missingHint(name) {
  if (name === 'telegram') return 'set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID';
  if (name === 'webhook') return 'set OWLEYE_WEBHOOK_URL';
  return '';
}
