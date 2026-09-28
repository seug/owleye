/**
 * Web Push adapter: notifications straight to the browser on a phone or a
 * laptop, with the page closed. No third party besides the browser vendor's
 * push service (FCM for Chrome, APNs for Safari, Mozilla for Firefox).
 *
 * The adapter owns the VAPID pair and the subscription list (see
 * ../webpush.js). Subscriptions are created by the web UI ("Уведомления на
 * это устройство") through /api/push/subscribe, so with the adapter switched on
 * and nobody subscribed, events are simply not pushed anywhere — that is
 * reported as delivered to zero devices, not as a failure.
 *
 * The payload is small (a few hundred bytes); the clip itself is shown by the
 * service worker from /media/... on the owleye server.
 */
import { openStore, sendPush } from '../webpush.js';
import { INTL_LOCALE, translator } from '../../public/lib/i18n.js';

let store = null;

export function pushStore() {
  return store;
}

export default {
  name: 'webpush',

  isEnabled() {
    return true;
  },

  describe() {
    return store ? `${store.count()} subscription(s)` : '';
  },

  async init(config) {
    store = await openStore(config);
    const keys = store.generated ? 'generated a new VAPID pair' : 'VAPID pair loaded';
    return `${keys}, ${store.count()} subscription(s) in ${store.dir}`;
  },

  async send(event, config) {
    const subscriptions = store.list(event.session ?? 'default');
    if (!subscriptions.length) return { delivered: 0, subscribers: 0 };

    const allowLoopbackHttp = config.devAllowInsecureOutbound === true;
    const outcomes = await Promise.allSettled(
      subscriptions.map((sub) =>
        sendPush(sub, JSON.stringify(buildPayload(event, config, sub.token)), store.vapid, {
          ttl: config.webpush.ttl,
          urgency: 'high',
          allowLoopbackHttp,
        }),
      ),
    );

    let delivered = 0;
    let dropped = 0;
    const errors = [];
    for (const [i, outcome] of outcomes.entries()) {
      if (outcome.status === 'fulfilled' && outcome.value.gone) {
        dropped++;
        await store.remove(subscriptions[i].endpoint, event.session ?? 'default');
      } else if (outcome.status === 'fulfilled') {
        delivered++;
      } else {
        errors.push(outcome.reason?.message ?? String(outcome.reason));
      }
    }

    if (!delivered && errors.length) throw new Error(errors[0]);
    return { delivered, subscribers: subscriptions.length, dropped, errors: errors.length ? errors : undefined };
  },
};

function buildPayload(event, config, token = '') {
  const t = translator(event.lang);
  const titleKey = ['motion', 'offline', 'online', 'test'].includes(event.kind) ? `notify.${event.kind}` : 'notify.other';
  const bits = [new Date(event.at).toLocaleString(INTL_LOCALE[event.lang] ?? 'en-GB', { hour12: false })];
  if (typeof event.score === 'number') bits.push(t('notify.intensity', { pct: (event.score * 100).toFixed(1) }));
  if (event.note) bits.push(event.note);

  // The service worker resolves these against its own origin. The token is the
  // one the subscriber signed up with (older subscriptions predate that and
  // fall back to the master token); the payload is end-to-end encrypted to that
  // browser, so it does not leak through the push service.
  const effective = token || config.token;
  const auth = effective ? `?t=${encodeURIComponent(effective)}` : '';
  return {
    id: event.id,
    kind: event.kind,
    at: event.at,
    title: t(titleKey, { kind: event.kind, device: event.device }),
    body: bits.join('\n').slice(0, 500),
    image: event.mediaUrl ? `${event.mediaUrl}${auth}` : undefined,
    url: `/${auth}`,
  };
}
