#!/usr/bin/env node
/**
 * Self-test for the parts of owleye that can run without a camera:
 * GIF encoder, motion detector, adapter fan-out, the HTTP server, and the
 * ntfy / Web Push adapters against local mocks of their services.
 *
 * Run: npm test
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes, verify } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync, symlinkSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { encodeGif } from '../public/lib/gif.js';
import { createMotionDetector } from '../public/lib/motion.js';
import { assertSafeUrl, isForbiddenIp } from '../server/net-guard.js';
import { evictToFit, pruneExpired, sessionUsageBytes } from '../server/storage.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

let failures = 0;
const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (!ok) failures++;
  const mark = ok ? '  ok  ' : ' FAIL ';
  console.log(`[${mark}] ${name}${detail ? ` — ${detail}` : ''}`);
}

function assertClose(name, actual, expected, tolerance) {
  check(name, Math.abs(actual - expected) <= tolerance, `${actual.toFixed(4)} vs ${expected} ±${tolerance}`);
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { ...opts });
    const stdout = [];
    const stderr = [];
    child.stdout?.on('data', (c) => stdout.push(c));
    child.stderr?.on('data', (c) => stderr.push(c));
    child.on('error', (err) => resolve({ code: -1, stdout: Buffer.alloc(0), stderr: Buffer.from(String(err)) }));
    child.on('close', (code) => resolve({ code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) }));
  });
}

async function hasTool(cmd) {
  const r = await run('which', [cmd]);
  return r.code === 0;
}

// --- Synthetic footage -------------------------------------------------------

/** A moving bright square on a dark noisy background, like a person crossing a room. */
function makeFrames({ width, height, count, boxSize = 12, noise = 0 }) {
  const frames = [];
  for (let f = 0; f < count; f++) {
    const frame = new Uint8ClampedArray(width * height * 4);
    const ox = Math.round((f / Math.max(1, count - 1)) * (width - boxSize - 1));
    const oy = Math.round(height / 2 - boxSize / 2);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        const inBox = x >= ox && x < ox + boxSize && y >= oy && y < oy + boxSize;
        const base = inBox ? 220 : 40;
        const n = noise ? Math.round((Math.random() - 0.5) * 2 * noise) : 0;
        frame[i] = base + n;
        frame[i + 1] = (inBox ? 180 : 55) + n;
        frame[i + 2] = (inBox ? 60 : 80) + n;
        frame[i + 3] = 255;
      }
    }
    frames.push(frame);
  }
  return frames;
}

function staticFrames({ width, height, count, noise = 6 }) {
  const frames = [];
  for (let f = 0; f < count; f++) {
    const frame = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < frame.length; i += 4) {
      const n = Math.round((Math.random() - 0.5) * 2 * noise);
      frame[i] = 60 + n;
      frame[i + 1] = 62 + n;
      frame[i + 2] = 70 + n;
      frame[i + 3] = 255;
    }
    frames.push(frame);
  }
  return frames;
}

// --- 1. GIF encoder ----------------------------------------------------------

async function testGif(workdir) {
  const width = 96;
  const height = 72;
  const frames = makeFrames({ width, height, count: 10 });
  const bytes = encodeGif(frames, { width, height, delay: 120 });

  check('gif: header is GIF89a', Buffer.from(bytes.subarray(0, 6)).toString('ascii') === 'GIF89a');
  check('gif: trailer is 0x3B', bytes[bytes.length - 1] === 0x3b);
  check('gif: non-trivial size', bytes.length > 500, `${bytes.length} bytes`);

  const gifPath = join(workdir, 'motion.gif');
  writeFileSync(gifPath, bytes);

  if (!(await hasTool('magick'))) {
    check('gif: decoder verification', true, 'skipped, ImageMagick not installed');
    return;
  }

  const id = await run('magick', ['identify', '-format', '%n %w %h\n', gifPath]);
  const first = id.stdout.toString().trim().split('\n')[0] || '';
  const [n, w, h] = first.split(' ').map(Number);
  check('gif: ImageMagick parses it', id.code === 0, id.stderr.toString().trim().slice(0, 200));
  check('gif: frame count round-trips', n === frames.length, `got ${n}, want ${frames.length}`);
  check('gif: dimensions round-trip', w === width && h === height, `got ${w}x${h}`);

  // Decode frame 5 back to raw RGBA and compare against the source pixels.
  const idx = 5;
  const dec = await run('magick', [`${gifPath}[${idx}]`, '-depth', '8', 'rgba:-']);
  const decoded = dec.stdout;
  check('gif: decoded raw size matches', decoded.length === width * height * 4, `${decoded.length}`);

  if (decoded.length === width * height * 4) {
    const src = frames[idx];
    let sum = 0;
    let worst = 0;
    for (let i = 0; i < src.length; i += 4) {
      for (let c = 0; c < 3; c++) {
        const d = Math.abs(src[i + c] - decoded[i + c]);
        sum += d;
        if (d > worst) worst = d;
      }
    }
    const mae = sum / ((src.length / 4) * 3);
    check('gif: pixels survive quantization (MAE < 6)', mae < 6, `MAE ${mae.toFixed(2)}, worst ${worst}`);
  }

  // A gradient stresses the palette much harder than flat colour blocks.
  const gw = 128;
  const gh = 96;
  const grad = new Uint8ClampedArray(gw * gh * 4);
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      const i = (y * gw + x) * 4;
      grad[i] = (x / gw) * 255;
      grad[i + 1] = (y / gh) * 255;
      grad[i + 2] = 128;
      grad[i + 3] = 255;
    }
  }
  const gradPath = join(workdir, 'gradient.gif');
  writeFileSync(gradPath, encodeGif([grad], { width: gw, height: gh, delay: 100 }));
  const gdec = await run('magick', [`${gradPath}[0]`, '-depth', '8', 'rgba:-']);
  if (gdec.stdout.length === gw * gh * 4) {
    let sum = 0;
    for (let i = 0; i < grad.length; i += 4) {
      for (let c = 0; c < 3; c++) sum += Math.abs(grad[i + c] - gdec.stdout[i + c]);
    }
    const mae = sum / ((grad.length / 4) * 3);
    check('gif: gradient palette quality (MAE < 8)', mae < 8, `MAE ${mae.toFixed(2)}`);
  } else {
    check('gif: gradient decodes', false, `got ${gdec.stdout.length} bytes`);
  }

  // Regression: a dim room is the real operating condition, and it is the case
  // that broke before — a background covering most of the frame used to swallow
  // every other colour, leaving a uniformly dark clip that proves nothing.
  const dw = 160;
  const dh = 120;
  const darkFrames = [];
  for (let t = 0; t < 6; t++) {
    const f = new Uint8ClampedArray(dw * dh * 4);
    const put = (x, y, r, g, b) => {
      if (x < 0 || y < 0 || x >= dw || y >= dh) return;
      const i = (y * dw + x) * 4;
      f[i] = r;
      f[i + 1] = g;
      f[i + 2] = b;
      f[i + 3] = 255;
    };
    for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) put(x, y, 35, 38, 46); // wall
    for (let y = 75; y < 110; y++) for (let x = 10; x < 55; x++) put(x, y, 49, 53, 63); // furniture
    const px = Math.round((t / 6) * dw) - 15;
    for (let y = 45; y < 95; y++) for (let x = px; x < px + 14; x++) put(x, y, 216, 201, 168); // person
    darkFrames.push(f);
  }

  const darkPath = join(workdir, 'dark.gif');
  writeFileSync(darkPath, encodeGif(darkFrames, { width: dw, height: dh, delay: 160 }));
  const ddec = await run('magick', [`${darkPath}[3]`, '-depth', '8', 'rgba:-']);

  if (ddec.stdout.length === dw * dh * 4) {
    const src = darkFrames[3];
    let sum = 0;
    for (let i = 0; i < src.length; i += 4) {
      for (let c = 0; c < 3; c++) sum += Math.abs(src[i + c] - ddec.stdout[i + c]);
    }
    const mae = sum / ((src.length / 4) * 3);
    check('gif: dark scene survives (MAE < 4)', mae < 4, `MAE ${mae.toFixed(2)}`);

    // The three tones must stay distinguishable, not collapse into the wall.
    const at = (x, y, c) => ddec.stdout[(y * dw + x) * 4 + c];
    const wall = at(150, 10, 0);
    const furniture = at(30, 90, 0);
    const person = at(Math.round((3 / 6) * dw) - 15 + 7, 70, 0);
    check(
      'gif: dark scene keeps wall, furniture and person apart',
      Math.abs(furniture - wall) > 8 && person - wall > 120,
      `wall=${wall} furniture=${furniture} person=${person}`,
    );
  } else {
    check('gif: dark scene decodes', false, `got ${ddec.stdout.length} bytes`);
  }
}

// --- 2. Motion detector ------------------------------------------------------

function testMotion() {
  const width = 96;
  const height = 72;

  const quiet = createMotionDetector({ width, height, warmupFrames: 4 });
  const noiseFrames = staticFrames({ width, height, count: 20, noise: 8 });
  let quietMax = 0;
  let quietTriggers = 0;
  for (const f of noiseFrames) {
    const r = quiet.update(f);
    if (!r.warming) {
      quietMax = Math.max(quietMax, r.score);
      if (r.moved) quietTriggers++;
    }
  }
  check('motion: sensor noise does not trigger', quietTriggers === 0, `max score ${quietMax.toFixed(4)}`);

  const active = createMotionDetector({ width, height, warmupFrames: 4 });
  const moving = makeFrames({ width, height, count: 24, boxSize: 14, noise: 8 });
  let triggers = 0;
  let peak = 0;
  let bbox = null;
  for (const f of moving) {
    const r = active.update(f);
    if (r.moved) {
      triggers++;
      if (r.score > peak) {
        peak = r.score;
        bbox = r.bbox;
      }
    }
  }
  check('motion: a moving object triggers', triggers > 5, `${triggers} triggered frames, peak ${peak.toFixed(4)}`);
  check('motion: bounding box is reported', !!bbox, bbox ? `${bbox.w}x${bbox.h} at ${bbox.x},${bbox.y}` : 'none');

  const warm = createMotionDetector({ width, height, warmupFrames: 5 });
  const warmFrames = makeFrames({ width, height, count: 5, boxSize: 20 });
  const warming = warmFrames.map((f) => warm.update(f).warming);
  check('motion: warmup suppresses early frames', warming.every(Boolean), `${warming.length} frames warming`);

  const sens = createMotionDetector({ width, height, warmupFrames: 2, areaThreshold: 0.9 });
  const sensFrames = makeFrames({ width, height, count: 10, boxSize: 10 });
  sensFrames.forEach((f) => sens.update(f));
  sens.setSensitivity({ areaThreshold: 0.001 });
  const after = sens.update(makeFrames({ width, height, count: 2, boxSize: 30 })[1]);
  check('motion: sensitivity is adjustable at runtime', after.moved, `score ${after.score.toFixed(4)}`);
}

// --- 3. Server + adapters end to end ----------------------------------------

async function testServer(workdir) {
  const dataDir = join(workdir, 'data');
  const port = 31900 + Math.floor(Math.random() * 400);

  const server = spawn(process.execPath, [join(ROOT, 'server', 'index.js')], {
    env: {
      ...process.env,
      OWLEYE_PORT: String(port),
      OWLEYE_DATA_DIR: dataDir,
      OWLEYE_ADAPTERS: 'file',
      OWLEYE_NO_CAFFEINATE: '1',
      OWLEYE_TOKEN: 'testtoken',
      OWLEYE_OFFLINE_AFTER: '0',
      OWLEYE_OPEN_SIGNUP: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  server.stdout.on('data', (c) => logs.push(c));
  server.stderr.on('data', (c) => logs.push(c));

  const base = `http://127.0.0.1:${port}`;
  const auth = { 'x-owleye-token': 'testtoken' };

  try {
    let up = false;
    for (let i = 0; i < 60; i++) {
      try {
        const r = await fetch(`${base}/api/health`, { headers: auth });
        if (r.ok) {
          up = true;
          break;
        }
      } catch {
        /* not listening yet */
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    check('server: starts and answers /api/health', up, up ? '' : logs.join('').slice(-400));
    if (!up) return;

    const unauth = await fetch(`${base}/api/events`);
    check('server: rejects requests without the token', unauth.status === 401, `status ${unauth.status}`);
    check(
      'server: API gets JSON on 401, not the gate page',
      String(unauth.headers.get('content-type')).includes('application/json'),
      String(unauth.headers.get('content-type')),
    );

    const gate = await fetch(`${base}/`, { headers: { accept: 'text/html,*/*' } });
    const gateHtml = await gate.text();
    check(
      'server: browser without a token sees the gate page',
      gate.status === 401 && gateHtml.includes('action="/session"') && !gateHtml.includes('class="error"'),
      `status ${gate.status}`,
    );
    check('server: gate page is not indexable', gate.headers.get('x-robots-tag') === 'noindex, nofollow');
    const gateLang = async (accept, query = '') =>
      (await (await fetch(`${base}/${query}`, { headers: { accept: 'text/html', 'accept-language': accept } })).text());
    const gEn = await gateLang('en-US,en;q=0.9');
    const gRu = await gateLang('ru-RU,ru;q=0.9,en;q=0.8');
    const gTh = await gateLang('th-TH,th;q=0.9');
    const gHr = await gateLang('hr-HR,hr;q=0.9,en;q=0.5');
    const gEnRs = await gateLang('en-RS');
    const gForced = await gateLang('ru', '?lang=sr');
    check('i18n: gate in English by default', gEn.includes('<html lang="en">') && gEn.includes('Open session') && !/[А-Яа-я]/.test(gEn), gEn.match(/<html[^>]*>/)?.[0]);
    check('i18n: gate in Russian for ru', gRu.includes('<html lang="ru">') && gRu.includes('Перейти к сессии'));
    check('i18n: gate in Thai for th', gTh.includes('<html lang="th">') && gTh.includes('เปิดเซสชัน'));
    check('i18n: gate in Serbian for hr (ex-Yugoslav locales)', gHr.includes('<html lang="sr">') && gHr.includes('Otvori sesiju'));
    check('i18n: English-in-Serbia region maps to Serbian', gEnRs.includes('<html lang="sr">'));
    check('i18n: ?lang= overrides the browser locale', gForced.includes('<html lang="sr">') && gForced.includes('Otvori sesiju'));
    check('i18n: no leftover template markers on the gate', !/\{\{[\w.]+\}\}/.test(gTh));
    const signupLang = await fetch(`${base}/signup`, { method: 'POST', redirect: 'manual', headers: { 'accept-language': 'sl-SI' } });
    const slSid = (signupLang.headers.get('location') ?? '').match(/t=([a-f0-9]{32})/)?.[1] ?? '';
    const slCfg = await (await fetch(`${base}/api/config`, { headers: { 'x-owleye-token': slSid } })).json();
    check('i18n: a new session inherits the browser language', slCfg.session?.lang === 'sr', String(slCfg.session?.lang));

    const badSession = await fetch(`${base}/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'token=nope',
    });
    const badHtml = await badSession.text();
    check(
      'server: gate rejects a wrong token and shows the error',
      badSession.status === 401 && badHtml.includes('class="error"') && !badSession.headers.get('set-cookie'),
      `status ${badSession.status}`,
    );

    const goodSession = await fetch(`${base}/session`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'token=testtoken',
    });
    check(
      'server: gate accepts the token, sets the cookie and redirects home',
      goodSession.status === 303 &&
        goodSession.headers.get('location') === '/?mode=view' &&
        String(goodSession.headers.get('set-cookie')).includes('owleye_token=testtoken'),
      `status ${goodSession.status} → ${goodSession.headers.get('location')}`,
    );

    // Sessions: self-signup from the gate, isolated feed / clips / settings.
    const gateSignup = await fetch(`${base}/`, { headers: { accept: 'text/html' } });
    check('sessions: gate offers signup when OWLEYE_OPEN_SIGNUP is on', (await gateSignup.text()).includes('action="/signup"'));
    const signup = await fetch(`${base}/signup`, { method: 'POST', redirect: 'manual' });
    const sid = (signup.headers.get('location') ?? '').match(/t=([a-f0-9]{32})/)?.[1] ?? '';
    check(
      'sessions: signup creates a session and opens record mode',
      signup.status === 303 && Boolean(sid) && signup.headers.get('location') === `/?t=${sid}&mode=record` && String(signup.headers.get('set-cookie')).includes(sid),
      `status ${signup.status} → ${signup.headers.get('location')}`,
    );
    const sAuth = { 'x-owleye-token': sid };
    const sCfg = await (await fetch(`${base}/api/config`, { headers: sAuth })).json();
    check(
      'sessions: /api/config describes the session',
      sCfg.session?.id === sid && sCfg.session.isDefault === false && sCfg.token === sid && sCfg.openSignup === true && sCfg.session.ntfy.topic === '',
      JSON.stringify(sCfg.session),
    );
    const mCfg = await (await fetch(`${base}/api/config`, { headers: auth })).json();
    check('sessions: master token opens the default session', mCfg.session?.isDefault === true && mCfg.token === 'testtoken', JSON.stringify(mCfg.session));
    const viewSession = await fetch(`${base}/session`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `token=${sid}&mode=view`,
    });
    check('sessions: gate opens a pasted id in view mode', viewSession.status === 303 && viewSession.headers.get('location') === '/?mode=view', `${viewSession.status} → ${viewSession.headers.get('location')}`);

    const sGif = encodeGif(makeFrames({ width: 32, height: 24, count: 3 }), { width: 32, height: 24, delay: 100 });
    const sPost = await fetch(`${base}/api/event`, {
      method: 'POST',
      headers: { ...sAuth, 'content-type': 'image/gif', 'x-owleye-meta': Buffer.from(JSON.stringify({ device: 'guestcam', kind: 'motion', score: 0.2 })).toString('base64') },
      body: sGif,
    });
    const sEvent = (await sPost.json()).event;
    const sFeed = await (await fetch(`${base}/api/events`, { headers: sAuth })).json();
    const mFeed = await (await fetch(`${base}/api/events`, { headers: auth })).json();
    check(
      'sessions: an event lands in its own feed only',
      sPost.ok && sFeed.events?.some((e) => e.id === sEvent.id) && !mFeed.events?.some((e) => e.id === sEvent.id),
      `session feed ${sFeed.events?.length}, master feed ${mFeed.events?.length}`,
    );
    const rootDays = existsSync(join(dataDir, 'events')) ? readdirSync(join(dataDir, 'events')) : [];
    check(
      'sessions: clips are stored under sessions/<id>/',
      existsSync(join(dataDir, 'sessions', sid, 'events')) && !rootDays.some((d) => readdirSync(join(dataDir, 'events', d)).some((f) => f.includes('guestcam'))),
    );
    const ownMedia = await fetch(`${base}${sEvent.mediaUrl}`, { headers: sAuth });
    const crossMedia = await fetch(`${base}${sEvent.mediaUrl}`, { headers: auth });
    check('sessions: a clip is served to its session and not across', ownMedia.status === 200 && crossMedia.status === 404, `own ${ownMedia.status}, cross ${crossMedia.status}`);

    const savedNtfy = await (
      await fetch(`${base}/api/session`, {
        method: 'POST',
        headers: { ...sAuth, 'content-type': 'application/json' },
        body: JSON.stringify({ ntfy: { url: 'https://ntfy.example', topic: 'guest-topic-1', token: 'tk_secret' } }),
      })
    ).json();
    check(
      'sessions: ntfy settings are saved per session and the token is not echoed',
      savedNtfy.ok && savedNtfy.session.ntfy.topic === 'guest-topic-1' && savedNtfy.session.ntfy.url === 'https://ntfy.example' && savedNtfy.session.ntfy.tokenSet === true && !JSON.stringify(savedNtfy).includes('tk_secret'),
      JSON.stringify(savedNtfy.session?.ntfy),
    );
    const sessionsFile = join(dataDir, 'sessions.json');
    check('sessions: persisted to sessions.json', existsSync(sessionsFile) && readFileSync(sessionsFile, 'utf8').includes(sid));
    const badTopic = await fetch(`${base}/api/session`, {
      method: 'POST',
      headers: { ...sAuth, 'content-type': 'application/json' },
      body: JSON.stringify({ ntfy: { topic: 'has space' } }),
    });
    check('sessions: bad topic rejected', badTopic.status === 400, `status ${badTopic.status}`);
    let limited = 0;
    for (let i = 0; i < 6; i++) {
      const r = await fetch(`${base}/signup`, { method: 'POST', redirect: 'manual' });
      if (r.status === 429) limited++;
    }
    check('sessions: signup is rate-limited per IP', limited >= 1, `${limited} of 6 limited`);

    const index = await fetch(`${base}/?t=testtoken`);
    const html = await index.text();
    check('server: serves the web UI with a token', index.ok && html.includes('owleye'), `status ${index.status}`);
    check(
      'server: hands out a session cookie',
      String(index.headers.get('set-cookie') || '').includes('owleye_token'),
      String(index.headers.get('set-cookie')),
    );

    const width = 64;
    const height = 48;
    const gif = encodeGif(makeFrames({ width, height, count: 6 }), { width, height, delay: 100 });
    const meta = {
      device: 'selftest',
      kind: 'motion',
      score: 0.37,
      frames: 6,
      width,
      height,
      at: new Date().toISOString(),
    };
    const post = await fetch(`${base}/api/event`, {
      method: 'POST',
      headers: {
        ...auth,
        'content-type': 'image/gif',
        'x-owleye-meta': Buffer.from(JSON.stringify(meta), 'utf8').toString('base64'),
      },
      body: gif,
    });
    const posted = await post.json().catch(() => ({}));
    check('server: accepts a motion event', post.ok && posted.ok, `status ${post.status} ${JSON.stringify(posted).slice(0, 160)}`);

    const eventsDir = join(dataDir, 'events');
    const days = existsSync(eventsDir) ? readdirSync(eventsDir) : [];
    let saved = null;
    for (const day of days) {
      for (const f of readdirSync(join(eventsDir, day))) {
        if (f.endsWith('.gif')) saved = join(eventsDir, day, f);
      }
    }
    check('server: file adapter wrote the media', !!saved, saved ? saved.replace(workdir, '<tmp>') : 'nothing on disk');
    if (saved) {
      const onDisk = readFileSync(saved);
      check('server: stored bytes match what was sent', onDisk.length === gif.length && onDisk[0] === 0x47);
      check('server: sidecar metadata written', existsSync(saved.replace(/\.gif$/, '.json')));
    }

    const list = await fetch(`${base}/api/events`, { headers: auth });
    const json = await list.json();
    check('server: event shows up in the feed', Array.isArray(json.events) && json.events.length === 1, `${json.events?.length} events`);
    check('server: feed keeps the score', json.events?.[0]?.score === 0.37, String(json.events?.[0]?.score));

    const big = await fetch(`${base}/api/event`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'image/gif', 'x-owleye-meta': Buffer.from('{}').toString('base64') },
      body: Buffer.alloc(40 * 1024 * 1024),
    });
    check('server: rejects oversized uploads', big.status === 413, `status ${big.status}`);
  } finally {
    server.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 250));
    if (!server.killed) server.kill('SIGKILL');
  }
}

// --- 4. ntfy + Web Push against mock services --------------------------------

/** Browser side of Web Push: the P-256 pair and auth secret a PushSubscription carries. */
function makeSubscriber() {
  const ecdh = createECDH('prime256v1');
  const publicKey = ecdh.generateKeys();
  const auth = randomBytes(16);
  return { ecdh, publicKey, auth, keys: { p256dh: publicKey.toString('base64url'), auth: auth.toString('base64url') } };
}

/** RFC 8291 decryption, written independently of the server's encryptor. */
function decryptPush(body, subscriber) {
  const salt = body.subarray(0, 16);
  const rs = body.readUInt32BE(16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const ciphertext = body.subarray(21 + idlen);
  const shared = subscriber.ecdh.computeSecret(asPublic);
  const info = Buffer.concat([Buffer.from('WebPush: info\0'), subscriber.publicKey, asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', shared, subscriber.auth, info, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  const padded = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()]);
  const delimiter = padded.lastIndexOf(0x02);
  return { rs, idlen, text: padded.subarray(0, delimiter).toString('utf8') };
}

function decodeHeader(value) {
  const m = /^=\?UTF-8\?B\?(.+)\?=$/.exec(String(value ?? ''));
  return m ? Buffer.from(m[1], 'base64').toString('utf8') : String(value ?? '');
}

/** One mock that plays both ntfy (topic + health) and a push service (/push/...). */
function startMock() {
  const received = { ntfy: [], push: [] };
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const entry = { method: req.method, url: req.url, headers: req.headers, body };
      if (req.url === '/v1/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"healthy":true}');
      } else if (req.url.startsWith('/push/')) {
        received.push.push(entry);
        res.writeHead(req.url === '/push/gone' ? 410 : 201);
        res.end();
      } else {
        received.ntfy.push(entry);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: `mock${received.ntfy.length}` }));
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, received, port: server.address().port }));
  });
}

async function testPushAdapters(workdir) {
  const mock = await startMock();
  const mockBase = `http://127.0.0.1:${mock.port}`;
  const dataDir = join(workdir, 'push-data');
  const port = 32300 + Math.floor(Math.random() * 400);

  const server = spawn(process.execPath, [join(ROOT, 'server', 'index.js')], {
    env: {
      ...process.env,
      OWLEYE_PORT: String(port),
      OWLEYE_DATA_DIR: dataDir,
      OWLEYE_ADAPTERS: 'file,ntfy,webpush',
      OWLEYE_NO_CAFFEINATE: '1',
      OWLEYE_TOKEN: 'testtoken',
      OWLEYE_OFFLINE_AFTER: '0',
      OWLEYE_OPEN_SIGNUP: '1',
      // The ntfy and push mocks live on 127.0.0.1; let the SSRF guard reach them.
      OWLEYE_DEV_ALLOW_INSECURE_OUTBOUND: '1',
      NTFY_URL: mockBase,
      NTFY_TOPIC: 'owleye-selftest',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  server.stdout.on('data', (c) => logs.push(c));
  server.stderr.on('data', (c) => logs.push(c));

  const base = `http://127.0.0.1:${port}`;
  const auth = { 'x-owleye-token': 'testtoken' };
  const postJson = (path, body) =>
    fetch(`${base}${path}`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(body) });

  try {
    let up = false;
    for (let i = 0; i < 60; i++) {
      try {
        if ((await fetch(`${base}/api/health`, { headers: auth })).ok) {
          up = true;
          break;
        }
      } catch {
        /* not listening yet */
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    check('push: server starts with ntfy + webpush', up, up ? '' : logs.join('').slice(-400));
    if (!up) return;

    const cfg = await (await fetch(`${base}/api/config`, { headers: auth })).json();
    check('push: both adapters active', cfg.adapters?.includes('ntfy') && cfg.adapters?.includes('webpush'), String(cfg.adapters));
    const vapidPublic = Buffer.from(String(cfg.pushPublicKey ?? ''), 'base64url');
    check('push: VAPID public key is a P-256 point', vapidPublic.length === 65 && vapidPublic[0] === 0x04, `${vapidPublic.length} bytes`);
    check('push: VAPID pair persisted', existsSync(join(dataDir, 'webpush', 'vapid.json')));

    const manifest = await (await fetch(`${base}/manifest.webmanifest`, { headers: auth })).json();
    check('push: manifest start_url carries the token', manifest.start_url === '/?t=testtoken', manifest.start_url);

    const bad = await postJson('/api/push/subscribe', { subscription: { endpoint: `${mockBase}/push/bad`, keys: { p256dh: 'x', auth: 'y' } } });
    check('push: malformed subscription rejected', bad.status === 400, `status ${bad.status}`);

    const alive = makeSubscriber();
    const gone = makeSubscriber();
    const s1 = await (await postJson('/api/push/subscribe', { subscription: { endpoint: `${mockBase}/push/alive`, keys: alive.keys }, label: 'selftest' })).json();
    const s2 = await (await postJson('/api/push/subscribe', { subscription: { endpoint: `${mockBase}/push/gone`, keys: gone.keys } })).json();
    check('push: subscriptions stored', s1.ok && s2.ok && s2.subscriptions === 2, `${s2.subscriptions} stored`);

    const guestSignup = await fetch(`${base}/signup`, { method: 'POST', redirect: 'manual' });
    const guestSid = (guestSignup.headers.get('location') ?? '').match(/t=([a-f0-9]{32})/)?.[1] ?? '';
    const third = makeSubscriber();
    const s3 = await (
      await fetch(`${base}/api/push/subscribe`, {
        method: 'POST',
        headers: { 'x-owleye-token': guestSid, 'content-type': 'application/json' },
        body: JSON.stringify({ subscription: { endpoint: `${mockBase}/push/guest`, keys: third.keys }, label: 'guest' }),
      })
    ).json();
    check('sessions: another session subscribes to push separately', s3.ok && s3.subscriptions === 1, `${s3.subscriptions} in the guest session`);
    check('push: subscriptions persisted', existsSync(join(dataDir, 'webpush', 'subscriptions.json')));

    const width = 64;
    const height = 48;
    const gif = encodeGif(makeFrames({ width, height, count: 6 }), { width, height, delay: 100 });
    const langSet = await (await postJson('/api/session', { lang: 'ru' })).json();
    check('i18n: session language saved', langSet.ok && langSet.session.lang === 'ru', JSON.stringify(langSet.session?.lang));
    const meta = { device: 'selftest', kind: 'motion', score: 0.5, frames: 6, width, height, at: new Date().toISOString() };
    const post = await fetch(`${base}/api/event`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'image/gif', 'x-owleye-meta': Buffer.from(JSON.stringify(meta)).toString('base64') },
      body: gif,
    });
    const posted = await post.json();
    const byName = Object.fromEntries((posted.event?.adapters ?? []).map((a) => [a.name, a]));
    check('push: motion event delivered by ntfy and webpush', byName.ntfy?.ok === true && byName.webpush?.ok === true, JSON.stringify(posted.event?.adapters));

    const n = mock.received.ntfy[0];
    check('ntfy: clip uploaded with PUT to the topic', n?.method === 'PUT' && n.url === '/owleye-selftest', `${n?.method} ${n?.url}`);
    check('ntfy: body is the GIF bytes', n && n.body.length === gif.length && n.body[0] === 0x47, `${n?.body.length} bytes`);
    check('ntfy: title survives RFC 2047', decodeHeader(n?.headers.title) === 'Движение — selftest', decodeHeader(n?.headers.title));
    check('ntfy: message carries the score', decodeHeader(n?.headers.message).includes('интенсивность 50.0%'), decodeHeader(n?.headers.message));
    check('ntfy: filename, priority and tags set', n?.headers.filename?.endsWith('.gif') && n?.headers.priority === 'high' && n?.headers.tags === 'eye', `${n?.headers.filename} ${n?.headers.priority} ${n?.headers.tags}`);

    const p = mock.received.push.find((r) => r.url === '/push/alive');
    check('webpush: push service received the message', !!p, `${mock.received.push.length} pushes`);
    if (p) {
      check('webpush: aes128gcm content encoding', p.headers['content-encoding'] === 'aes128gcm' && p.headers.ttl === '3600', `${p.headers['content-encoding']} ttl=${p.headers.ttl}`);
      const authz = String(p.headers.authorization ?? '');
      const jwt = /t=([^,\s]+)/.exec(authz)?.[1] ?? '';
      const [h, c, sig] = jwt.split('.');
      let claims = {};
      try {
        claims = JSON.parse(Buffer.from(c ?? '', 'base64url').toString());
      } catch {
        /* checked below */
      }
      check('webpush: VAPID audience is the push service origin', claims.aud === mockBase && claims.exp > Date.now() / 1000, JSON.stringify(claims));
      const pubKey = createPublicKey({
        key: { kty: 'EC', crv: 'P-256', x: vapidPublic.subarray(1, 33).toString('base64url'), y: vapidPublic.subarray(33).toString('base64url') },
        format: 'jwk',
      });
      const validSig = authz.endsWith(`k=${cfg.pushPublicKey}`)
        && verify('sha256', Buffer.from(`${h}.${c}`), { key: pubKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig ?? '', 'base64url'));
      check('webpush: VAPID JWT signature verifies against the advertised key', validSig);

      let payload = null;
      let detail = '';
      try {
        const dec = decryptPush(p.body, alive);
        payload = JSON.parse(dec.text);
        detail = `rs=${dec.rs} idlen=${dec.idlen}`;
      } catch (err) {
        detail = err.message;
      }
      check('webpush: payload decrypts with the subscriber keys', !!payload, detail);
      check('webpush: payload names the event', payload?.title === 'Движение — selftest' && payload?.kind === 'motion', payload?.title);
      check('webpush: payload links the clip with the token', /^\/media\/.+\.gif\?t=testtoken$/.test(payload?.image ?? ''), payload?.image);
    }

    const after = await (await fetch(`${base}/api/push/vapid`, { headers: auth })).json();
    check('webpush: 410 from the push service drops the subscription', after.subscriptions === 1, `${after.subscriptions} left`);

    const test = await (await fetch(`${base}/api/test`, { method: 'POST', headers: auth })).json();
    const t = mock.received.ntfy[1];
    check('ntfy: event without media is a text POST', test.ok && t?.method === 'POST' && !t.headers.filename && t.body.toString().includes('Проверка связи'), `${t?.method} ${t?.body.toString().slice(0, 40)}`);

    await postJson('/api/session', { lang: 'th' });
    const thTest = await (await fetch(`${base}/api/test`, { method: 'POST', headers: auth })).json();
    const thNtfy = mock.received.ntfy[2];
    check(
      'i18n: notifications follow the session language (Thai)',
      thTest.event?.note?.includes('ตรวจสอบการเชื่อมต่อ') && decodeHeader(thNtfy?.headers.title) === 'เหตุการณ์ทดสอบ — owleye-server',
      `${thTest.event?.note?.slice(0, 30)} / ${decodeHeader(thNtfy?.headers.title)}`,
    );
    const badLang = await postJson('/api/session', { lang: 'xx' });
    check('i18n: unknown language rejected', badLang.status === 400, `status ${badLang.status}`);

    const un = await (await postJson('/api/push/unsubscribe', { endpoint: `${mockBase}/push/alive` })).json();
    check('webpush: unsubscribe removes the endpoint', un.ok && un.removed === 1 && un.subscriptions === 0, JSON.stringify(un));
  } finally {
    server.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 250));
    if (!server.killed) server.kill('SIGKILL');
    mock.server.close();
  }
}

// --- 5. Security hardening ---------------------------------------------------

/** Wait until a spawned server answers /api/health. */
async function waitUp(base, auth) {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${base}/api/health`, { headers: auth });
      if (r.ok) return true;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

function b64meta(meta) {
  return Buffer.from(JSON.stringify(meta), 'utf8').toString('base64');
}

async function testHardening(workdir) {
  // --- net-guard (no server) ---
  check(
    'net-guard: blocks loopback / private / link-local / multicast',
    ['127.0.0.1', '10.0.0.5', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '::1', 'fe80::1', 'fc00::1', 'ff02::1', '::ffff:127.0.0.1'].every(
      isForbiddenIp,
    ),
  );
  check('net-guard: allows public addresses', !isForbiddenIp('8.8.8.8') && !isForbiddenIp('2606:4700:4700::1111'));

  const rejects = (fn) => {
    try {
      fn();
      return false;
    } catch {
      return true;
    }
  };
  check('net-guard: rejects non-HTTPS outbound URL', rejects(() => assertSafeUrl('http://ntfy.sh/x')));
  check('net-guard: rejects credentials in the URL', rejects(() => assertSafeUrl('https://user:pass@ntfy.sh/x')));
  check('net-guard: enforces the origin allowlist', rejects(() => assertSafeUrl('https://evil.example/x', { allowedOrigins: ['https://ntfy.sh'] })));
  check('net-guard: allows an allowlisted HTTPS origin', !rejects(() => assertSafeUrl('https://ntfy.sh/x', { allowedOrigins: ['https://ntfy.sh'] })));

  // --- storage accounting (no server) ---
  const sdir = join(workdir, 'storage', 'events', '2026-09-20');
  mkdirSync(sdir, { recursive: true });
  const eventsRoot = join(workdir, 'storage', 'events');
  const now = Date.now();
  const makeEvent = (stem, bytes, ageSec) => {
    const media = join(sdir, `${stem}.gif`);
    const meta = join(sdir, `${stem}.json`);
    writeFileSync(media, Buffer.alloc(bytes));
    writeFileSync(meta, '{}');
    const t = new Date(now - ageSec * 1000) / 1000;
    utimesSync(media, t, t);
    utimesSync(meta, t, t);
  };
  makeEvent('e1-old', 1000, 3000);
  makeEvent('e2-mid', 1000, 2000);
  makeEvent('e3-new', 1000, 1000);
  const usageBefore = await sessionUsageBytes(eventsRoot);
  check('storage: usage sums media + sidecars', usageBefore >= 3000 && usageBefore < 3200, `${usageBefore} bytes`);

  const evicted = await evictToFit(eventsRoot, 1500, 0, console);
  const afterUsage = await sessionUsageBytes(eventsRoot);
  check(
    'storage: evicts oldest first down to the budget',
    afterUsage <= 1500 && existsSync(join(sdir, 'e3-new.gif')) && !existsSync(join(sdir, 'e1-old.gif')),
    `${afterUsage} bytes, deleted ${evicted.deleted}`,
  );

  const pdir = join(workdir, 'storage-prune', 'events', '2026-09-20');
  mkdirSync(pdir, { recursive: true });
  const proot = join(workdir, 'storage-prune', 'events');
  for (const [stem, age] of [['fresh', 100], ['stale', 10000]]) {
    const f = join(pdir, `${stem}.gif`);
    writeFileSync(f, Buffer.alloc(100));
    const t = new Date(now - age * 1000) / 1000;
    utimesSync(f, t, t);
  }
  await pruneExpired(proot, 5000 * 1000, now, console);
  check('storage: retention drops events past the window', existsSync(join(pdir, 'fresh.gif')) && !existsSync(join(pdir, 'stale.gif')));

  // A symlink planted in a session is never followed while measuring.
  const linkDir = join(workdir, 'storage-link', 'events', '2026-09-20');
  mkdirSync(linkDir, { recursive: true });
  const secret = join(workdir, 'secret-outside.bin');
  writeFileSync(secret, Buffer.alloc(9999));
  symlinkSync(secret, join(linkDir, 'link.gif'));
  const linkUsage = await sessionUsageBytes(join(workdir, 'storage-link', 'events'));
  check('storage: does not follow symlinks out of a session', linkUsage === 0, `${linkUsage} bytes counted`);

  // --- HTTP server: traversal, quota, rate limit, headers, XFF ---
  const dataDir = join(workdir, 'hard-data');
  const port = 32400 + Math.floor(Math.random() * 400);
  const server = spawn(process.execPath, [join(ROOT, 'server', 'index.js')], {
    env: {
      ...process.env,
      OWLEYE_PORT: String(port),
      OWLEYE_DATA_DIR: dataDir,
      OWLEYE_ADAPTERS: 'file',
      OWLEYE_NO_CAFFEINATE: '1',
      OWLEYE_TOKEN: 'testtoken',
      OWLEYE_OFFLINE_AFTER: '0',
      OWLEYE_OPEN_SIGNUP: '1',
      OWLEYE_SESSION_MAX_BYTES: '12000',
      OWLEYE_EVENT_RATE_PER_MINUTE: '30',
      OWLEYE_TRUSTED_PROXIES: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  server.stdout.on('data', (c) => logs.push(c));
  server.stderr.on('data', (c) => logs.push(c));

  const base = `http://127.0.0.1:${port}`;
  const auth = { 'x-owleye-token': 'testtoken' };

  try {
    const up = await waitUp(base, auth);
    check('hardening: server starts', up, up ? '' : logs.join('').slice(-400));
    if (!up) return;

    // Security headers on HTML, API and media responses.
    const cfg = await fetch(`${base}/api/config`, { headers: auth });
    const wantHeaders = {
      'content-security-policy': 'default-src',
      'strict-transport-security': 'max-age=31536000',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'permissions-policy': 'camera=(self)',
      'cross-origin-resource-policy': 'same-origin',
    };
    const hasAll = (res) => Object.entries(wantHeaders).every(([h, v]) => String(res.headers.get(h) || '').includes(v));
    check('hardening: security headers on API responses', hasAll(cfg));
    const home = await fetch(`${base}/`, { headers: { ...auth, accept: 'text/html,*/*' } });
    check('hardening: security headers on HTML responses', hasAll(home));

    // meta.at path traversal in all its shapes is refused with 400, no write.
    const pwnMarker = `owleye-pwn-${Math.random().toString(36).slice(2)}`;
    const badAts = [
      `../../../../../../tmp/${pwnMarker}`,
      `..\\..\\..\\${pwnMarker}`,
      `/etc/${pwnMarker}`,
      `2026-09-20T00:00:00Z ${pwnMarker}`,
      'not-a-real-date',
      `${new Date(Date.now() + 5 * 24 * 3600 * 1000).toISOString()}`, // too far in the future
    ];
    const statuses = [];
    for (const at of badAts) {
      const r = await fetch(`${base}/api/event`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'image/gif', 'x-owleye-meta': b64meta({ device: 'x', at }) },
        body: Buffer.alloc(50),
      });
      statuses.push(r.status);
    }
    check('hardening: meta.at traversal / bad dates rejected with 400', statuses.every((s) => s === 400), statuses.join(','));
    check('hardening: nothing was written outside the events dir', !existsSync(join('/tmp', `${pwnMarker}.gif`)) && !existsSync(join('/tmp', pwnMarker)));

    // Quota: three 3 KiB clips, budget 12 KiB → the oldest is evicted.
    const clip = Buffer.alloc(3000, 1);
    for (let i = 0; i < 3; i++) {
      await fetch(`${base}/api/event`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'image/gif', 'x-owleye-meta': b64meta({ device: 'quota', at: new Date(now - (3 - i) * 1000).toISOString() }) },
        body: clip,
      });
    }
    const evDir = join(dataDir, 'events');
    const gifs = existsSync(evDir) ? readdirSync(evDir).flatMap((d) => readdirSync(join(evDir, d)).filter((f) => f.endsWith('.gif'))) : [];
    check('hardening: session stays within its byte budget (oldest evicted)', gifs.length === 2, `${gifs.length} clips on disk`);

    // A single clip that cannot be made to fit → 507, nothing stored.
    const huge = await fetch(`${base}/api/event`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'image/gif', 'x-owleye-meta': b64meta({ device: 'huge', at: new Date().toISOString() }) },
      body: Buffer.alloc(13000, 1),
    });
    check('hardening: an unfittable clip is refused with 507', huge.status === 507, `status ${huge.status}`);

    // Rate limit: a fresh session, hammered past 30/min, gets a 429 + Retry-After.
    const su = await fetch(`${base}/signup`, { method: 'POST', redirect: 'manual', headers: { 'x-forwarded-for': '9.9.9.9' } });
    const loc = su.headers.get('location') || '';
    const sid = (loc.match(/[?&]t=([a-f0-9]{32})/) || [])[1];
    check('hardening: signup issues a session id', Boolean(sid), loc);
    let got429 = null;
    if (sid) {
      for (let i = 0; i < 33; i++) {
        const r = await fetch(`${base}/api/event`, { method: 'POST', headers: { 'x-owleye-token': sid, 'content-type': 'application/json' }, body: '' });
        if (r.status === 429) {
          got429 = r;
          break;
        }
      }
    }
    check('hardening: POST /api/event is rate-limited (429 + Retry-After)', Boolean(got429) && Boolean(got429.headers.get('retry-after')), got429 ? `retry-after ${got429.headers.get('retry-after')}` : 'no 429');

    // Signup rate limit keys on the forwarded client IP, not the proxy.
    let ipA = 0;
    let firstLimited = 0;
    for (let i = 0; i < 6; i++) {
      const r = await fetch(`${base}/signup`, { method: 'POST', redirect: 'manual', headers: { 'x-forwarded-for': '203.0.113.7' } });
      if (r.status === 303) ipA++;
      else if (r.status === 429 && !firstLimited) firstLimited = i + 1;
    }
    const otherIp = await fetch(`${base}/signup`, { method: 'POST', redirect: 'manual', headers: { 'x-forwarded-for': '198.51.100.9' } });
    check(
      'hardening: signup limit uses the forwarded client IP',
      ipA === 5 && firstLimited === 6 && otherIp.status === 303,
      `${ipA} allowed, first limited #${firstLimited}, other-IP ${otherIp.status}`,
    );
  } finally {
    server.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 250));
    if (!server.killed) server.kill('SIGKILL');
  }
}

// --- 6. SSRF guard on outbound adapters --------------------------------------

async function testOutboundGuard(workdir) {
  const dataDir = join(workdir, 'ssrf-data');
  const port = 32900 + Math.floor(Math.random() * 400);
  // No OWLEYE_DEV_ALLOW_INSECURE_OUTBOUND — production mode: private targets blocked.
  const server = spawn(process.execPath, [join(ROOT, 'server', 'index.js')], {
    env: {
      ...process.env,
      OWLEYE_PORT: String(port),
      OWLEYE_DATA_DIR: dataDir,
      OWLEYE_ADAPTERS: 'file,ntfy',
      OWLEYE_NO_CAFFEINATE: '1',
      OWLEYE_TOKEN: 'testtoken',
      OWLEYE_OFFLINE_AFTER: '0',
      OWLEYE_OPEN_SIGNUP: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs = [];
  server.stdout.on('data', (c) => logs.push(c));
  server.stderr.on('data', (c) => logs.push(c));
  const base = `http://127.0.0.1:${port}`;
  const auth = { 'x-owleye-token': 'testtoken' };

  try {
    const up = await waitUp(base, auth);
    check('ssrf: server starts', up, up ? '' : logs.join('').slice(-400));
    if (!up) return;

    // A public session opens, then points ntfy at internal targets.
    const su = await fetch(`${base}/signup`, { method: 'POST', redirect: 'manual', headers: { 'x-forwarded-for': '203.0.113.20' } });
    const sid = ((su.headers.get('location') || '').match(/[?&]t=([a-f0-9]{32})/) || [])[1];
    const sAuth = { 'x-owleye-token': sid };

    const setNtfy = (url) =>
      fetch(`${base}/api/session`, {
        method: 'POST',
        headers: { ...sAuth, 'content-type': 'application/json' },
        body: JSON.stringify({ ntfy: { url, topic: 'pwn' } }),
      });

    const postEvent = () =>
      fetch(`${base}/api/event`, {
        method: 'POST',
        headers: { ...sAuth, 'content-type': 'image/gif', 'x-owleye-meta': b64meta({ device: 'x', at: new Date().toISOString() }) },
        body: Buffer.alloc(40),
      }).then((r) => r.json());

    const blocked = (adapters) => {
      const n = adapters?.find((a) => a.name === 'ntfy');
      return n && n.ok === false;
    };

    await setNtfy('https://169.254.169.254'); // cloud metadata, link-local
    const meta = await postEvent();
    check('ssrf: ntfy to the metadata address is blocked', blocked(meta.event?.adapters), JSON.stringify(meta.event?.adapters));

    await setNtfy('http://127.0.0.1:80'); // loopback, plain HTTP
    const loop = await postEvent();
    check('ssrf: ntfy to loopback is blocked', blocked(loop.event?.adapters), JSON.stringify(loop.event?.adapters));

    await setNtfy('https://ntfy.example.internal'); // not on the allowlist
    const off = await postEvent();
    check('ssrf: ntfy to a non-allowlisted origin is blocked', blocked(off.event?.adapters), JSON.stringify(off.event?.adapters));

    // The file adapter still delivered every one of those events.
    check('ssrf: the clip is still stored despite the blocked adapter', off.event?.adapters?.some((a) => a.name === 'file' && a.ok), JSON.stringify(off.event?.adapters));
  } finally {
    server.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 250));
    if (!server.killed) server.kill('SIGKILL');
  }
}

// --- main --------------------------------------------------------------------

const workdir = mkdtempSync(join(tmpdir(), 'owleye-selftest-'));
console.log(`owleye self-test\nworkdir: ${workdir}\n`);

try {
  console.log('GIF encoder');
  await testGif(workdir);
  console.log('\nMotion detector');
  testMotion();
  console.log('\nServer and adapters');
  await testServer(workdir);
  console.log('\nntfy and Web Push adapters');
  await testPushAdapters(workdir);
  console.log('\nSecurity hardening');
  await testHardening(workdir);
  console.log('\nSSRF guard');
  await testOutboundGuard(workdir);
} finally {
  rmSync(workdir, { recursive: true, force: true });
}

const passed = results.length - failures;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(failures === 0 ? 0 : 1);
