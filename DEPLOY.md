# Deploying owleye on a server

Written for an agent or engineer with shell access to a fresh server and no
other context. Follow it top to bottom; every step ends with a check and its
expected output. Do not skip the checks — several defaults elsewhere in the
stack (nginx body size, SSE buffering) break owleye silently.

## 0. Read this before touching the server

**The server is not a camera.** owleye records through a *browser* on a device
with a camera — a laptop or a phone. That browser does the watching, the motion
detection and the encoding, then uploads short clips. What you are deploying
here is the receiving half: it serves the web interface, accepts clips, stores
them and forwards them to adapters (file, ntfy, Web Push, Telegram, webhook).

```
   ┌──────────────────────────┐             ┌────────────────────────────┐
   │ phone / laptop in the     │  HTTPS     │ this server                │
   │ room, browser open        │ ─────────► │ node server/index.js       │
   │                           │            │                            │
   │ camera → motion detect →  │            │ stores clips on disk       │
   │ GIF/JPEG                  │            │ → ntfy / push / Telegram   │
   └──────────────────────────┘             └────────────────────────────┘
```

Consequences, all of which matter for this deployment:

1. **A server with no attached camera records nothing by itself.** If nobody
   opens the web interface on a device with a camera, the deployment is idle
   and healthy — and there will be no clips. That is not a fault.
2. **HTTPS is mandatory, not a nicety.** Browsers expose the camera only in a
   secure context. `http://<ip>:8443` gives you a working web page where the
   camera silently refuses to start. Only `https://…` (or `localhost` on the
   same machine) works.
3. **Set a token.** This endpoint accepts uploads and serves recordings of
   people. On a public address, run it with `OWLEYE_TOKEN`.
4. **Recording people has legal obligations.** Notify everyone who can appear in
   frame before switching a camera on, and check local retention rules; §10
   configures automatic deletion.

## 1. Requirements

| Item | Requirement |
|---|---|
| OS | Any Linux with systemd (Debian/Ubuntu assumed below), or macOS |
| Node.js | **18.17+** (20 or 22 recommended) |
| Dependencies | none — no `npm install`, no build step |
| Disk | clips are 50–200 KB each; 1 GB holds tens of thousands |
| Ports | 443 public (via proxy), 8443 on loopback |
| `openssl` | only if owleye generates its own certificate (§6, option C) |

Check Node:

```bash
node --version
```

Expected: `v18.17.0` or higher. If missing or older, on Debian/Ubuntu:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version
```

## 2. Put the code on the server

The project is a plain directory — no build artifacts, no lockfile. Copy it
from the machine that has it:

```bash
# from your workstation, inside the owleye directory
rsync -av --exclude data --exclude certs --exclude .env --exclude node_modules \
      ./ user@server:/tmp/owleye-src/
```

Then on the server:

```bash
sudo mkdir -p /opt/owleye
sudo cp -r /tmp/owleye-src/. /opt/owleye/
```

If you keep it in git, `sudo git clone <url> /opt/owleye` instead.

**Check** — these files must exist:

```bash
ls /opt/owleye/server/index.js /opt/owleye/public/app.js /opt/owleye/package.json
```

## 3. Create the service user and directories

```bash
sudo useradd --system --home /opt/owleye --shell /usr/sbin/nologin owleye
sudo mkdir -p /var/lib/owleye
sudo chown -R owleye:owleye /opt/owleye /var/lib/owleye
sudo chmod 750 /var/lib/owleye        # recordings are sensitive
```

## 4. Run the built-in self-test

Before wiring anything up, confirm the code works on this machine. It needs no
network and no camera.

```bash
cd /opt/owleye && sudo -u owleye node scripts/selftest.mjs
```

Expected last line: `105/105 checks passed`. (A few GIF checks self-skip if
ImageMagick is absent — that is fine, it is only used by the test.)

If this fails, stop: nothing downstream will work.

## 5. Configure

Create `/etc/owleye.env`. Generate a strong token and keep a copy — every camera
device needs it.

```bash
TOKEN=$(openssl rand -hex 24); echo "your token: $TOKEN"
sudo tee /etc/owleye.env >/dev/null <<EOF
OWLEYE_HOST=127.0.0.1
OWLEYE_PORT=8443
OWLEYE_HTTPS=0
OWLEYE_TOKEN=$TOKEN
OWLEYE_DATA_DIR=/var/lib/owleye
OWLEYE_ADAPTERS=file,console
# OWLEYE_OPEN_SIGNUP=1   # let anyone create their own isolated session from the gate page (trials)
OWLEYE_OFFLINE_AFTER=120
OWLEYE_MAX_UPLOAD=1048576
OWLEYE_TRUSTED_PROXIES=1
EOF
sudo chmod 640 /etc/owleye.env
sudo chown root:owleye /etc/owleye.env
```

`OWLEYE_HOST=127.0.0.1` keeps owleye off the public interface — the proxy in §6
is what faces the internet. Use option C in §6 if you are not running a proxy;
that one needs `OWLEYE_HOST=0.0.0.0` and `OWLEYE_TRUSTED_PROXIES=0`.

`OWLEYE_TRUSTED_PROXIES=1` tells owleye it sits behind exactly one reverse proxy
(§6 A/B), so it reads the real client IP from `X-Forwarded-For` for the signup
rate limit. Leave it at the default `0` only when nothing fronts owleye —
otherwise every visitor looks like the proxy and the per-IP limit collapses to a
single shared bucket.

With open signup on, owleye now enforces its own limits per session: a 1 MiB
cap per upload, a 10 MiB on-disk budget (oldest clips evicted first), a 24-hour
retention window, and 30 events per minute. Tune with `OWLEYE_SESSION_MAX_BYTES`,
`OWLEYE_RETENTION_SECONDS` and `OWLEYE_EVENT_RATE_PER_MINUTE`.

Full list of settings: `/opt/owleye/.env.example`.

## 6. TLS — pick one option

Decide by what you have. This is the step people get wrong, and the symptom is
always the same: page loads, camera never starts.

| You have | Use | Certificate warning? |
|---|---|---|
| A domain pointing at the server | **A** (Caddy) or **B** (nginx) | no |
| Only an IP address | **C** (owleye serves TLS), or **A** with a wildcard-DNS hostname | yes, accept once per device |

### Option A — Caddy (simplest, needs a domain)

```bash
sudo apt-get install -y caddy
sudo cp /opt/owleye/deploy/Caddyfile.example /etc/caddy/Caddyfile
sudo sed -i 's/owleye.example.com/YOUR.DOMAIN/; s/you@example.com/YOUR@EMAIL/' /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

### Option B — nginx + certbot (needs a domain)

```bash
sudo apt-get install -y nginx certbot python3-certbot-nginx
sudo cp /opt/owleye/deploy/nginx-owleye.conf.example /etc/nginx/sites-available/owleye
sudo sed -i 's/owleye.example.com/YOUR.DOMAIN/' /etc/nginx/sites-available/owleye
sudo ln -sf /etc/nginx/sites-available/owleye /etc/nginx/sites-enabled/owleye
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d YOUR.DOMAIN
```

The supplied config already sets the three things whose defaults break owleye:
`client_max_body_size 2m`, `proxy_buffering off`, `proxy_read_timeout 3600s`.
If you write your own, carry those over.

### Option C — no domain, owleye terminates TLS itself

owleye generates a self-signed certificate on first run, with the machine's
addresses in `subjectAltName`. Browsers show a warning that must be accepted
once per device; the camera works normally afterwards, because a secure context
depends on the scheme, not on the certificate being trusted.

Edit `/etc/owleye.env`:

```
OWLEYE_HOST=0.0.0.0
OWLEYE_PORT=8443
OWLEYE_HTTPS=1
```

To use a certificate you obtained yourself, point owleye at it instead — then no
warning appears:

```
OWLEYE_TLS_KEY=/etc/ssl/private/owleye-key.pem
OWLEYE_TLS_CERT=/etc/ssl/certs/owleye-cert.pem
```

Make sure the `owleye` user can read both, and that the unit's `ReadWritePaths`
includes `/opt/owleye/certs` when it generates its own.

To bind port 443 directly, uncomment `AmbientCapabilities=CAP_NET_BIND_SERVICE`
in the unit file. Otherwise keep 8443 and reach it as `https://HOST:8443/`.

> Tip for the bare-IP case: wildcard DNS services (`nip.io`, `sslip.io`) map
> `1-2-3-4.nip.io` to `1.2.3.4`, which gives you a hostname a certificate
> authority will issue for — turning option C into option A. Verify the service
> resolves before relying on it.

## 7. Install the service

```bash
sudo cp /opt/owleye/deploy/owleye.service /etc/systemd/system/owleye.service
sudo systemctl daemon-reload
sudo systemctl enable --now owleye
sudo systemctl status owleye --no-pager
```

Expected: `active (running)`, and in the log a banner listing the URLs and the
adapter states.

```bash
sudo journalctl -u owleye -n 30 --no-pager
```

## 8. Firewall

```bash
sudo ufw allow OpenSSH
sudo ufw allow 443/tcp          # or 8443/tcp for option C on the default port
sudo ufw enable
sudo ufw status
```

Port 8443 must **not** be open publicly when a proxy fronts it (§6 A/B).

## 9. Verify the deployment

Run all of these. Replace `HOST` and `TOKEN`.

```bash
# 1. Service is healthy on loopback
curl -s http://127.0.0.1:8443/api/health -H "x-owleye-token: TOKEN"
# → {"ok":true,"uptimeSeconds":...,"devices":[]}

# 2. It refuses anonymous access (a browser gets a styled page asking for
#    the token instead of this JSON — same 401 status)
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8443/api/events
# → 401

# 3. Reachable from outside over TLS (add -k for option C's self-signed cert)
curl -s https://HOST/api/health -H "x-owleye-token: TOKEN"
# → {"ok":true,...}

# 4. The web interface is served
curl -s "https://HOST/?t=TOKEN" | grep -c owleye
# → a number > 0

# 5. Adapters deliver — this posts a test event through every enabled adapter
curl -s -X POST https://HOST/api/test -H "x-owleye-token: TOKEN"
# → {"ok":true,"event":{...,"adapters":[{"name":"file","ok":true},...]}}

# 6. The upload path accepts a clip end to end
curl -s -X POST https://HOST/api/event \
  -H "x-owleye-token: TOKEN" -H 'content-type: image/gif' \
  -H "x-owleye-meta: $(printf '{"device":"deploy-check","kind":"motion","score":0.5}' | base64 | tr -d '\n')" \
  --data-binary @/opt/owleye/public/lib/nosleep.mp4
# → {"ok":true,"event":{...}}

# 7. It landed on disk
sudo ls -R /var/lib/owleye/events | tail -5
```

A full browser-level check, without needing a camera: open

```
https://HOST/?t=TOKEN&fakecam=1&autostart=1
```

on any device. It feeds the app a generated scene, so within about half a minute
clips appear in the event list at the bottom of the page and in
`/var/lib/owleye/events`. This exercises detection, encoding, upload and the
adapters for real. Close the tab afterwards.

## 10. Disk housekeeping

owleye never deletes anything by itself.

```bash
sudo cp /opt/owleye/deploy/owleye-prune.service /opt/owleye/deploy/owleye-prune.timer /etc/systemd/system/
sudo nano /etc/systemd/system/owleye-prune.service   # set -mtime +N to your retention period
# The unit sweeps both the default session (events/) and sessions/*/events/.
sudo systemctl daemon-reload
sudo systemctl enable --now owleye-prune.timer
systemctl list-timers owleye-prune --no-pager
```

## 11. Connect a camera device

For a person, not the agent:

1. On the laptop or phone that will watch the room, open
   `https://HOST/?t=TOKEN`. Accept the certificate warning if option C was used.
2. Give the device a recognisable name in **Имя устройства** (it is stamped onto
   every frame and used in alerts).
3. Press **Включить камеру** and allow access.
4. Tune **чувствительность** and **порог шума** while watching the motion bar:
   it should sit near zero in an empty room and jump when someone moves.
5. Press **Погасить экран** so the device looks switched off. Three taps or
   `Esc` bring it back.
6. Leave the device plugged in. Keep the tab in the foreground — the page holds
   a wake lock, and on a phone also enable the sound keep-alive checkbox.

If the camera does not start, the cause is almost always that the address is not
HTTPS.

## 12. Alerts to a phone

Three channels; enable any combination in `OWLEYE_ADAPTERS`. Check first which
of them the server can actually reach — some networks (Russian cloud
providers, for one) black-hole `api.telegram.org`:

```bash
for h in https://api.telegram.org/ https://ntfy.sh/ https://fcm.googleapis.com/ https://web.push.apple.com/; do
  printf '%s -> ' "$h"; curl -s -o /dev/null -m 8 -w '%{http_code}\n' "$h" || echo timeout
done
```

Expected: a three-digit status for each (any status means reachable; `000`
means blocked).

### 12a. ntfy (phone app, no account)

```bash
openssl rand -hex 12        # → the topic; treat it as a password
```

Add to `/etc/owleye.env` and restart:

```
OWLEYE_ADAPTERS=file,ntfy,console
NTFY_TOPIC=owleye-<the random hex>
```

```bash
sudo systemctl restart owleye
sudo journalctl -u owleye -n 20 --no-pager | grep 'adapter   ntfy'
```

Expected: `adapter   ntfy      active — https://ntfy.sh/****abcd`. Install the
ntfy app (Google Play, F-Droid, App Store), subscribe to the same topic, then:

```bash
curl -s -X POST https://HOST/api/test -H "x-owleye-token: TOKEN"
```

The phone shows "Тестовое событие — owleye-server" within seconds. Self-hosted
ntfy: set `NTFY_URL=https://ntfy.example.com` (and `NTFY_TOKEN` if auth is on);
the iOS app still needs `upstream-base-url: https://ntfy.sh` in the ntfy server
config, because Apple's push goes through ntfy.sh.

### 12b. Web Push (browser notifications)

Requires §6 option A or B — a certificate the phone's browser trusts.
Self-signed (option C) is enough for the camera but browsers refuse to
register push for it.

```
OWLEYE_ADAPTERS=file,webpush,console
WEBPUSH_SUBJECT=mailto:you@example.com
```

```bash
sudo systemctl restart owleye
sudo journalctl -u owleye -n 20 --no-pager | grep 'adapter   webpush'
```

Expected: `adapter   webpush   active — generated a new VAPID pair, 0
subscription(s) in /var/lib/owleye/webpush`. The pair lives in the data
directory, so it survives updates — keep it with the backup; a new pair
invalidates every phone's subscription (the UI notices and asks to subscribe
again).

Then on each device that should receive alerts: open `https://HOST/?t=TOKEN`,
press **Включить** under **Уведомления на это устройство**, allow. On an iPhone,
first add the page to the home screen (Share → **На экран «Домой»**) and open it
from there — iOS gives push only to installed web apps; the manifest carries
the token, so the icon opens straight into the app.

```bash
curl -s https://HOST/api/push/vapid -H "x-owleye-token: TOKEN"
```

Expected: `"subscriptions":1` per subscribed device. **Тест адаптеров** in the
UI (or `POST /api/test`) then rings the phone with the tab closed. Subscriptions
that the push service reports dead (410) are dropped automatically.

### 12c. Telegram

Create a bot with [@BotFather](https://t.me/BotFather), send it any message,
then read your chat id:

```bash
curl -s "https://api.telegram.org/bot<BOT_TOKEN>/getUpdates" | grep -o '"chat":{"id":[-0-9]*'
```

Add to `/etc/owleye.env` and restart:

```
OWLEYE_ADAPTERS=file,telegram,console
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
```

```bash
sudo systemctl restart owleye
curl -s -X POST https://HOST/api/test -H "x-owleye-token: TOKEN"
```

The response lists each adapter with `ok: true` or the exact error. A wrong
token shows up at startup as `adapter telegram failed — getMe failed:
Unauthorized`; owleye keeps running and the other adapters keep working.

## 13. Operations

```bash
sudo journalctl -u owleye -f                 # live log
sudo systemctl restart owleye                # restart
sudo du -sh /var/lib/owleye                  # disk used by recordings
curl -s https://HOST/api/health -H "x-owleye-token: TOKEN"   # which cameras are online
```

Update: sync the new code into `/opt/owleye`, then
`sudo -u owleye node scripts/selftest.mjs && sudo systemctl restart owleye`.
Configuration and recordings live outside the code directory, so they survive.

Backup: `/var/lib/owleye` (recordings) and `/etc/owleye.env` (config).

## 14. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Page loads, camera never starts | Address is not HTTPS | §6; `localhost` is the only non-HTTPS exception |
| `401` on every request | Token missing, wrong, or a revoked access key | Use `?t=TOKEN`, the `x-owleye-token` header, or type the token on the gate page a browser gets instead of the JSON |
| Clips fail to upload, `413` | Proxy body limit below `OWLEYE_MAX_UPLOAD`, or the clip is over the 1 MiB cap | `client_max_body_size 2m` (nginx); or lower clip length/width/FPS in the UI |
| Event list never updates live | SSE buffered by the proxy | `proxy_buffering off`, `proxy_read_timeout 3600s` |
| Live feed drops every minute | Proxy read timeout | same as above |
| Service dead, `EADDRINUSE` | Port already taken | `sudo ss -lptn 'sport = :8443'` |
| Service dead, `EACCES` on 443 | Unprivileged bind | Use a proxy, or enable `CAP_NET_BIND_SERVICE` |
| `ENOENT`/`EACCES` writing events | Data dir permissions | `chown -R owleye:owleye /var/lib/owleye`; check `ReadWritePaths` |
| Telegram `failed — Unauthorized` | Bad bot token | §12c |
| Telegram adapter `getMe` times out at startup | `api.telegram.org` blocked from this network | §12 reachability check; use ntfy or webpush |
| ntfy `init failed` | `NTFY_URL` unreachable or not an ntfy server | `curl -s $NTFY_URL/v1/health` must return `{"healthy":true}` |
| Push button says «Нужен HTTPS» or is missing | Page not served over trusted HTTPS, or `webpush` not in `OWLEYE_ADAPTERS` | §6 options A/B, §12b |
| Push subscribed, nothing arrives on the phone | Battery saver throttles the browser, or subscription died | Exempt the browser; `GET /api/push/vapid` shows the count, resubscribe from the UI |
| iPhone: push button disabled | Opened in Safari, not from the home-screen icon | §12b |
| Alerts say "Камера пропала" | No heartbeat for `OWLEYE_OFFLINE_AFTER`s | Device slept, lost network or the tab was closed — that alert is the feature working |
| Everything healthy, no clips | Nobody has a camera tab open | §11; the server records nothing on its own |

## 15. Known limits when self-hosting

- **Must be served at the domain root.** The interface uses absolute paths
  (`/app.js`, `/api/...`), so proxying it under a subpath like
  `example.com/owleye/` will not work.
- **Event rate limit is per session.** `OWLEYE_EVENT_RATE_PER_MINUTE` (default
  30) caps `POST /api/event`; add `limit_req` at the proxy too for defence in
  depth on a public address.
- **Single shared token per session.** No per-device credentials yet: one key
  grants read, write and settings for its session.
- **Built-in retention and quota.** Each session is held to
  `OWLEYE_SESSION_MAX_BYTES` and `OWLEYE_RETENTION_SECONDS`, swept at startup and
  every 10 minutes. The §10 prune timer is now a backstop, not the only guard.
- **Clips are GIF/JPEG, not video** — easy to preview anywhere, but silent and
  larger than equivalent video.
- **Not tested on Linux by the author.** The code has no platform-specific
  dependencies (the macOS-only `caffeinate` call is guarded by a platform
  check), and the self-test in §4 is the gate: if it passes on the server, the
  server half is sound.
