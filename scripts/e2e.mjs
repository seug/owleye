#!/usr/bin/env node
/**
 * End-to-end test in a real browser.
 *
 * Drives the page with ?fakecam=1, which feeds the app a generated scene
 * instead of a camera. That keeps the test honest — getUserMedia is the only
 * step stubbed, while detection, GIF encoding in a worker, upload, the server
 * and the adapters all run for real — and it works on machines with no camera.
 *
 * Run: npm run test:e2e
 */
import { spawn } from 'node:child_process';
import { existsSync, globSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { connectCdp, collectConsole } from './cdp.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function findChromium() {
  const candidates = [
    ...globSync(
      join(process.env.HOME ?? '', 'Library/Caches/ms-playwright/chromium-*/chrome-mac/Chromium.app/Contents/MacOS/Chromium'),
    ).sort(),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ];
  return candidates.reverse().find((p) => p && existsSync(p));
}

function run(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args);
    const out = [];
    child.stdout.on('data', (c) => out.push(c));
    child.stderr.on('data', (c) => out.push(c));
    child.on('error', () => resolve({ code: -1, out: '' }));
    child.on('close', (code) => resolve({ code, out: Buffer.concat(out).toString() }));
  });
}

const chromium = findChromium();
if (!chromium) {
  console.error('No Chromium found. Install one with: npx playwright install chromium');
  process.exit(2);
}

const workdir = mkdtempSync(join(tmpdir(), 'owleye-e2e-'));
const dataDir = join(workdir, 'data');
const port = 32100 + Math.floor(Math.random() * 300);
const cdpPort = 9400 + Math.floor(Math.random() * 300);

console.log('owleye end-to-end test');
console.log(`browser: ${chromium}`);
console.log(`workdir: ${workdir}\n`);

let failed = false;
const fail = (msg) => {
  console.log(`[ FAIL ] ${msg}`);
  failed = true;
};
const pass = (msg) => console.log(`[  ok  ] ${msg}`);

const server = spawn(process.execPath, [join(ROOT, 'server', 'index.js')], {
  env: {
    ...process.env,
    OWLEYE_PORT: String(port),
    OWLEYE_DATA_DIR: dataDir,
    OWLEYE_ADAPTERS: 'file,console',
    OWLEYE_NO_CAFFEINATE: '1',
    OWLEYE_TOKEN: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const serverLog = [];
server.stdout.on('data', (c) => serverLog.push(c));
server.stderr.on('data', (c) => serverLog.push(c));

let browser;
let cdp;
const pageLogs = [];

try {
  let up = false;
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) {
        up = true;
        break;
      }
    } catch {
      /* still starting */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!up) throw new Error(`server never came up:\n${Buffer.concat(serverLog).toString()}`);
  pass('server is up');

  browser = spawn(
    chromium,
    [
      '--headless=new',
      `--remote-debugging-port=${cdpPort}`,
      '--autoplay-policy=no-user-gesture-required',
      '--no-first-run',
      '--no-default-browser-check',
      '--mute-audio',
      '--disable-gpu',
      `--user-data-dir=${join(workdir, 'profile')}`,
      `http://127.0.0.1:${port}/?fakecam=1&autostart=1`,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  browser.stdout.on('data', () => {});
  browser.stderr.on('data', () => {});

  try {
    cdp = await connectCdp(cdpPort, { timeoutMs: 30000 });
  } catch (err) {
    // The browser failing to come up is an environment problem, not a verdict
    // on owleye — exit 2 so CI can tell the two apart.
    console.error(`\nCould not attach to the browser: ${err.message}`);
    console.error('This is a launch problem, not a test failure. Try:');
    console.error('  pkill -f ms-playwright   # clear stale browser processes');
    console.error('  npm run test:e2e');
    console.error('The self-test (npm test) covers the server and encoder without a browser.');
    server.kill('SIGKILL');
    browser?.kill('SIGKILL');
    rmSync(workdir, { recursive: true, force: true });
    process.exit(2);
  }
  collectConsole(cdp, pageLogs);
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  pass('browser attached over CDP');

  // The page should start watching on its own.
  let started = false;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const running = await cdp.evaluate('!!(window.__owleye && window.__owleye.state.running)').catch(() => false);
    if (running) {
      started = true;
      break;
    }
  }
  started ? pass('page started watching by itself') : fail('page never reached the running state');

  if (started) {
    const info = await cdp.evaluate(`({
      source: window.__owleye.state.source && window.__owleye.state.source.kind,
      captureSize: window.__owleye.state.captureW + 'x' + window.__owleye.state.captureH,
    })`);
    pass(`frame source: ${info.source}, capture ${info.captureSize}`);
  }

  // Wait for a clip to reach the disk.
  const eventsDir = join(dataDir, 'events');
  let gifPath = null;
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline && !gifPath) {
    await new Promise((r) => setTimeout(r, 500));
    if (!existsSync(eventsDir)) continue;
    for (const day of readdirSync(eventsDir)) {
      for (const f of readdirSync(join(eventsDir, day))) {
        if (f.endsWith('.gif')) gifPath = join(eventsDir, day, f);
      }
    }
  }

  if (!gifPath) {
    fail('no motion event was produced within 90 s');
    const snapshot = await cdp
      .evaluate(`({ pill: document.getElementById('state-pill').textContent,
                    score: document.getElementById('score-text').textContent,
                    ring: window.__owleye.state.ring.length,
                    queue: window.__owleye.state.queue.length })`)
      .catch((e) => ({ error: e.message }));
    console.log('page snapshot:', JSON.stringify(snapshot));
    console.log('server log tail:', Buffer.concat(serverLog).toString().slice(-1500));
  } else {
    pass(`motion clip written: ${gifPath.replace(workdir, '<tmp>')}`);

    const size = statSync(gifPath).size;
    size > 5000 ? pass(`clip is ${(size / 1024).toFixed(0)} KB`) : fail(`clip suspiciously small: ${size} bytes`);

    const id = await run('magick', ['identify', '-format', '%n %w %h\n', gifPath]);
    if (id.code === 0) {
      const [n, w, h] = (id.out.trim().split('\n')[0] || '').split(' ').map(Number);
      n >= 5 ? pass(`GIF holds ${n} frames at ${w}x${h}`) : fail(`GIF has only ${n} frames`);

      // The clip must actually show the scene, not a flat rectangle: the bug
      // this guards against produced a valid but uniformly dark GIF.
      const colours = await run('magick', [`${gifPath}[2]`, '-format', '%k', 'info:']);
      const unique = Number(colours.out.trim());
      unique >= 4 ? pass(`clip frame holds ${unique} distinct colours`) : fail(`clip frame is nearly flat: ${unique} colours`);
    } else {
      pass('ImageMagick not available, skipped GIF inspection');
    }

    const metaPath = gifPath.replace(/\.gif$/, '.json');
    if (existsSync(metaPath)) {
      const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
      pass(`metadata: device=${meta.device} score=${(meta.score * 100).toFixed(1)}% frames=${meta.frames}`);
      meta.score > 0 ? pass('motion score recorded') : fail('motion score missing');
    } else {
      fail('metadata sidecar missing');
    }

    const feed = await (await fetch(`http://127.0.0.1:${port}/api/events`)).json();
    feed.events?.length ? pass(`server feed has ${feed.events.length} event(s)`) : fail('server feed is empty');

    const health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
    health.devices?.some((d) => d.online)
      ? pass(`device reported online: ${health.devices.map((d) => d.name).join(', ')}`)
      : fail('no device registered a heartbeat');

    // Blackout must not stop the capture loop — that is the whole point of it.
    await cdp.evaluate(`document.getElementById('btn-blackout').click()`);
    const tickBefore = await cdp.evaluate('window.__owleye.state.frameTimes.at(-1)');
    await new Promise((r) => setTimeout(r, 3000));
    const tickAfter = await cdp.evaluate('window.__owleye.state.frameTimes.at(-1)');
    const blacked = await cdp.evaluate(`!document.getElementById('blackout').hidden`);
    blacked && tickAfter !== tickBefore
      ? pass('capture keeps running with the screen blacked out')
      : fail(`blackout broke the loop (blacked=${blacked}, ticking=${tickAfter !== tickBefore})`);
  }

  const errors = pageLogs.filter((l) => l.level === 'error' || l.level === 'exception');
  errors.length === 0
    ? pass('no errors in the page console')
    : fail(`page console errors:\n${errors.slice(0, 5).map((e) => e.text).join('\n')}`);
} catch (err) {
  fail(err.message);
} finally {
  cdp?.close();
  browser?.kill('SIGKILL');
  server.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 400));
  server.kill('SIGKILL');
  rmSync(workdir, { recursive: true, force: true });
}

console.log(failed ? '\nend-to-end test FAILED' : '\nend-to-end test passed');
process.exit(failed ? 1 : 0);
