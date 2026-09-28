/**
 * owleye service worker — Web Push only.
 *
 * It does not intercept fetches or cache anything: the page keeps talking to
 * the server directly. Its whole job is to turn a push message into a
 * notification while the tab is closed, and to keep the subscription alive if
 * the push service rotates it.
 */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'owleye', body: event.data ? event.data.text() : '' };
  }

  const options = {
    body: data.body || '',
    tag: data.id ? `owleye-${data.id}` : undefined,
    icon: '/icon-192.png',
    badge: '/badge-96.png',
    image: data.image ? new URL(data.image, self.location.origin).href : undefined,
    data: { url: data.url || '/' },
    timestamp: data.at ? Date.parse(data.at) || Date.now() : Date.now(),
    requireInteraction: data.kind === 'motion' || data.kind === 'offline',
    vibrate: [200, 100, 200],
  };
  event.waitUntil(self.registration.showNotification(data.title || 'owleye', options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      const open = clients.find((c) => c.url.startsWith(self.location.origin));
      if (open) return open.focus();
      return self.clients.openWindow(target);
    }),
  );
});

// The push service may replace the subscription; re-register it with the same
// server key and tell owleye. Cookies carry the token here.
self.addEventListener('pushsubscriptionchange', (event) => {
  const key = event.oldSubscription?.options?.applicationServerKey;
  if (!key) return;
  event.waitUntil(
    self.registration.pushManager
      .subscribe({ userVisibleOnly: true, applicationServerKey: key })
      .then((sub) =>
        fetch('/api/push/subscribe', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ subscription: sub.toJSON(), label: 'renewed by service worker' }),
        }),
      )
      .catch(() => {}),
  );
});
