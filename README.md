# owleye

Turns a Mac or a phone into a motion-triggered camera. The browser watches the
picture, and when enough of the frame changes it sends a short GIF (or a single
JPEG) to a Node server running on your own machine, which fans it out to
adapters: a file on disk, a push notification to your phone (ntfy or Web Push),
Telegram, a webhook.

No dependencies — no `npm install`, no build step, no cloud. Node 18.17+ and a
browser are the whole stack.

## Install

```bash
node --version          # must be 18.17 or newer
git clone <this repo> owleye && cd owleye
node scripts/selftest.mjs    # expect: 105/105 checks passed
node server/index.js
```

There is nothing else to install: no package manager step, no compiler, no
database. Copying the directory is a valid install.

Then open <http://localhost:8443/>, press **Включить камеру**, and grant access.

Putting the receiving half on a server instead — service user, TLS, systemd,
reverse proxy, retention — is covered step by step in
**[DEPLOY.md](DEPLOY.md)**. Read §0 there first: the server does not record
anything by itself, it receives from a browser that has a camera.

## Before you point it at people

This records people. Tell everyone who might walk into frame, before you switch
it on — in most places that is the law, not a courtesy, and footage collected
without notice tends to be worthless as evidence anyway. Clips stay on your
machine unless you switch on an adapter that sends them somewhere.

## Running it

| Command | What it does |
|---|---|
| `node server/index.js` | HTTP on port 8443, camera works on this machine |
| `node server/index.js --https` | HTTPS with a self-signed cert — needed for phones |
| `npm test` | Self-test: encoder, detector, server, adapters |
| `npm run test:e2e` | Drives a real browser with a synthetic camera |

Useful flags: `--port 9000`, `--adapters file,telegram`, `--token secret123`,
`--data /path/to/clips`, `--no-caffeinate`.

### Using a phone as the camera

The camera API only works in a secure context. `localhost` counts as one, a LAN
IP over plain HTTP does not — so a phone needs HTTPS:

```bash
node server/index.js --https --token choose-a-secret
```

The server generates a self-signed certificate on first run (with your LAN
addresses in `subjectAltName`) and prints the URLs. Open the network URL on the
phone, accept the certificate warning once, allow the camera. The `?t=` token
from the printed URL is stored in a cookie, so you only need it once. A browser
that opens the address without a token gets a small page asking for it — the
same cookie is set, the token never appears in the URL. API clients still get
a JSON `401`.

### Sessions: several cameras and viewers on one server

A session is an isolated owleye: its own feed, clips, push subscriptions and
ntfy topic. The session id is also the key that opens it. The token from
`--token` / `OWLEYE_TOKEN` opens the *default* session, which keeps the classic
single-user layout; other sessions store their clips under
`<data>/sessions/<id>/events/`.

With `OWLEYE_OPEN_SIGNUP=1` (or `--open-signup`) the gate page grows a
**Создать сессию** button: the device that presses it gets a fresh id and
opens in record mode. Anyone with the id pastes it on the gate page (or opens
`/?t=<id>`) and sees that session in view mode — the feed and its
notifications, no camera. Inside the app the **Сессия** block shows the id,
copies the share link, and switches to another session by id; the mode switch
in the header (**Камера / Просмотр**) is per device.

Sign-ups are limited per IP (5 per 10 minutes) and in total
(`OWLEYE_MAX_SESSIONS`, default 500). With sign-up off, only the master token
and existing session ids open the server. `telegram` and `webhook` adapters,
configured from the environment, stay with the default session; `ntfy` is
configured per session in the UI (**Уведомления ntfy**), `NTFY_TOPIC` only
seeds the default one.

### Languages

The interface, the gate page and the notification texts come in four
languages, chosen from the locale — Russian for `ru`, Thai for `th`, Serbian
(Latin script) for `sr`, `hr`, `bs`, `cnr`, `mk`, `sl` and for any locale with
a region in that part of the world (`en-RS`), English for everything else.
The browser's language list decides in the app, `Accept-Language` on the gate
page; `?lang=en|ru|th|sr` or the selector in the footer overrides and is
remembered on the device. Server-side texts (event notes, ntfy / push /
Telegram titles) follow the language of the session, which the app reports on
load; all strings live in `public/lib/i18n.js`, shared by browser and server.

### Staying awake for hours

Three independent mechanisms, because no single one covers every device:

1. **`caffeinate`** — the server spawns `caffeinate -dims -w <pid>` on macOS, so
   the Mac will not sleep while owleye runs. It dies with the server.
2. **Screen Wake Lock API** — the page holds a `screen` wake lock. The system
   drops it whenever the document is hidden, so it is re-acquired on every
   `visibilitychange`.
3. **Fallbacks** — where the wake lock is unavailable (older iOS Safari, in-app
   browsers), a muted looping video keeps the screen on, and an optional silent
   audio graph ("Держать устройство активным звуковым хаком") stops the browser
   throttling a backgrounded tab.

On top of that, the capture loop is driven by a **worker-based metronome**, not
`setInterval` on the main thread: a backgrounded page is clamped to about one
tick per second, which would quietly reduce the camera to 1 FPS.

### Making the device look switched off

**Погасить экран** paints the whole screen black and hides the cursor, while
capture continues at full rate. Three taps or `Esc` bring it back.

Frames are pulled off the media track with `MediaStreamTrackProcessor` where it
exists, rather than drawn from a `<video>` element. A video element only decodes
while it is being rendered — precisely what a blacked-out stealth camera is not
doing.

### Serial capture (индикатор гаснет между сериями)

**Серийная съёмка** in the settings swaps the always-on stream for a sampled
one. Instead of holding the camera open — which keeps the hardware recording
indicator lit the whole time — the app opens the camera for a short burst of
stills, closes the track so the indicator goes out, waits, and repeats. Two
knobs: **Кадров в серии** (stills per burst) and **Пауза между сериями**
(seconds the camera stays closed).

The trade-off is real and deliberate: this is time-sampled, not continuous.
Motion that starts and ends entirely inside a pause is never seen. The motion
detector persists across bursts, so a scene that changed while the camera was
closed still registers on the next burst, but you lose everything that happened
during the gap. Shorter pauses narrow that blind window at the cost of lighting
the indicator more often. It suits a camera watching a mostly static scene, or a
proof-of-concept pointed only at yourself, far more than a security feed that
must not miss a fast event.

The indicator is a hardware notice to people in frame that recording is on. Use
this mode on your own camera and your own scene, not to record other people
without the light they rely on.

## How detection works

Every tick (6 FPS) the frame goes down two paths:

- **Analysis**: scaled to 96×72, converted to luma, 3×3 box blurred, compared
  pixel by pixel against the previous blurred frame. The fraction of pixels
  whose brightness moved by more than **порог шума** is the motion score. The
  blur is what keeps sensor noise in a dim room from firing constantly.
- **Capture**: drawn at clip resolution with the device name and wall-clock time
  burned in, then pushed into a ring buffer.

When the score stays above **чувствительность** for two consecutive frames, the
ring buffer (about a second of pre-roll — you see the person entering, not just
standing there) plus the following frames are encoded into a GIF in a Web Worker
and queued for upload. Failed uploads retry with backoff instead of being
dropped.

Tuning, in practice: raise **порог шума** if a dark room produces false alarms;
raise **чувствительность** if passing headlights or a curtain trigger clips;
lower it if you want to catch a hand reaching into frame.

### Camera goes quiet

Each camera sends a heartbeat every 30 seconds. If one stops for longer than
`OWLEYE_OFFLINE_AFTER`, the server raises an `offline` event through the same
adapters — covering the case where someone closes the laptop, covers the lens or
kills the tab. A matching `online` event fires when it comes back.

## Adapters

Switch them on with `OWLEYE_ADAPTERS=file,telegram` (order is delivery order).
One failing adapter never blocks the others; failures show up in the UI and in
the server log.

| Adapter | Configuration | Notes |
|---|---|---|
| `file` | always on | `data/events/YYYY-MM-DD/` — media + `.json` sidecar, plus `data/events.log` |
| `ntfy` | `NTFY_TOPIC` (+ `NTFY_URL`, `NTFY_TOKEN`) | phone app, clip attached to the notification |
| `webpush` | nothing — subscribe from the UI | browser notification with the tab closed, no third party |
| `telegram` | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | GIF via `sendAnimation`, JPEG via `sendPhoto` |
| `webhook` | `OWLEYE_WEBHOOK_URL`, `OWLEYE_WEBHOOK_SECRET` | POSTs raw bytes, metadata in `x-owleye-event` (base64 JSON) |
| `console` | always on | one line per event, handy while tuning |

Press **Тест адаптеров** in the UI to send a test event and see exactly which
adapters delivered it.

### ntfy — alerts in a phone app

[ntfy](https://ntfy.sh) is a free, open-source pub/sub notification service
with apps for Android and iOS. owleye publishes each event with one HTTP
request; the GIF rides along as an attachment (up to 15 MB, kept three hours on
ntfy.sh — the copy on your disk stays).

1. Choose a long random topic name; on the public server it is the only thing
   standing between the world and your alerts:
   `NTFY_TOPIC=owleye-$(openssl rand -hex 12)`
2. `OWLEYE_ADAPTERS=file,ntfy`, restart.
3. Install the ntfy app, subscribe to the same topic. **Тест адаптеров** should
   land on the phone within a second or two.

Motion and offline alerts go out with `NTFY_PRIORITY` (`high` by default, so
they break through the phone's quiet hours the way ntfy lets them); online and
test events are `default`. For a self-hosted server set `NTFY_URL`; `NTFY_TOKEN`
adds a bearer token for reserved topics or servers with auth on.

Clips travel through ntfy's server. If that is not acceptable, run your own
ntfy next to owleye, or use `webpush`, which never hands the picture to anyone
but your browser.

### webpush — browser notifications, no accounts anywhere

Web Push delivers through the browser vendor's own push service (Google for
Chrome, Apple for Safari, Mozilla for Firefox), so there is nothing to sign up
for. The payload is encrypted to the receiving browser (RFC 8291), the push
service sees only ciphertext; owleye signs it with a VAPID key pair it
generates on first run into `data/webpush/`.

1. `OWLEYE_ADAPTERS=file,webpush`, restart. The page must be served over
   **HTTPS with a certificate the browser trusts** — a self-signed one is not
   enough for push; see DEPLOY.md for Caddy + Let's Encrypt.
2. Open owleye on the device that should get the alerts, press **Включить**
   under **Уведомления на это устройство**, allow notifications.
3. **Тест адаптеров** shows a notification even if you now close the tab.

Every subscribed browser gets every event; subscriptions are kept in
`data/webpush/subscriptions.json` and pruned when the push service reports them
gone. The notification shows the clip, and a tap opens owleye.

Platform notes:

- **Android Chrome / Firefox**: works from the normal tab. Aggressive battery
  savers may delay delivery; exempt the browser if alerts arrive late.
- **iPhone / iPad**: iOS only allows push for web apps on the home screen.
  Share → **На экран «Домой»**, open owleye from that icon, then subscribe. The
  clip image is not shown in iOS notifications, the text and the tap-through are.
- **Desktop**: works in Chrome, Edge, Firefox and Safari 16+; the browser must
  be running (it may be minimised).

`WEBPUSH_SUBJECT` should be your email or site — push services use it to
contact the sender. `WEBPUSH_TTL` is how long a push waits for an offline device.

### Writing your own

Drop a module in `server/adapters/`, then register it in
`server/adapters/index.js`:

```js
export default {
  name: 'siren',
  isEnabled: (config) => Boolean(process.env.SIREN_URL),
  describe: () => process.env.SIREN_URL,
  async init(config) {},              // optional; throw to disable yourself
  async send(event, config) {
    // event: { id, at, device, kind: 'motion'|'offline'|'online'|'test',
    //          score, frames, width, height, note,
    //          media?: { buffer: Buffer, mime, ext } }
  },
};
```

## HTTP API

Everything the browser uses is a plain endpoint, so other clients can post to it
(add `x-owleye-token` when a token is configured).

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/event` | Raw media body, metadata in `x-owleye-meta` (base64 JSON) |
| `POST` | `/api/heartbeat` | `{ device }` — feeds the offline watchdog |
| `POST` | `/api/test` | Sends a test event through every adapter |
| `GET` | `/api/push/vapid` | Web Push public key and subscription count |
| `POST` | `/api/push/subscribe` | `{ subscription, label }` — a `PushSubscription.toJSON()` |
| `POST` | `/api/push/unsubscribe` | `{ endpoint }` |
| `GET` | `/api/events?limit=50` | Recent events |
| `GET` | `/api/stream` | Server-sent events, live feed |
| `GET` | `/api/health` | Uptime and per-device online state |
| `GET` | `/media/<day>/<file>` | A stored clip (`?download` to save it) |

## Layout

```
DEPLOY.md              server deployment, start to finish
deploy/                systemd units, Caddy and nginx examples
server/index.js        HTTP(S) server, routing, watchdog, caffeinate
server/config.js       env + .env + CLI flags
server/tls.js          self-signed certificate for phone access
server/adapters/       file, ntfy, webpush, telegram, webhook, console + registry
server/webpush.js      VAPID, RFC 8291 payload encryption, subscription store
public/sw.js           service worker: shows push notifications, nothing else
public/manifest        served dynamically by the server (home-screen app on phones)
public/app.js          camera, capture loop, triggering, upload queue, wake locks
public/lib/motion.js   frame-difference detector
public/lib/gif.js      dependency-free animated GIF encoder
public/worker-gif.js   encodes clips off the main thread
public/worker-ticker.js metronome that survives a backgrounded page
scripts/selftest.mjs   encoder, detector, server, adapters (ntfy and push against mocks)
scripts/e2e.mjs        real browser, synthetic camera, full chain
scripts/cdp.mjs        tiny Chrome DevTools Protocol client
scripts/debug-page.mjs attaches to a running browser and dumps page state
```

## Testing without a camera

`?fakecam=1` replaces the camera with a generated scene — a dim room with a
figure walking across it. Same MediaStream shape, so detection, encoding,
upload and adapters all run for real:

```
http://localhost:8443/?fakecam=1&autostart=1
```

`?autostart=1` on its own starts a real camera as soon as the page loads, which
is how you bring a camera back after a reboot.

## Known limits

- Clips are GIF, not video: easy to preview anywhere, but larger and silent.
  Above roughly 5 seconds at 640 px they get heavy — the server rejects
  anything over `OWLEYE_MAX_UPLOAD`.
- Detection is frame differencing, not recognition: it reacts to a person, and
  equally to a curtain, a cat or a lighting change.
- One tab, one camera. Several devices can point at the same server — give each
  its own **Имя устройства**.
- A self-signed certificate means a warning screen on first visit from a phone.
