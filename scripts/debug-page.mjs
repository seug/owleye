#!/usr/bin/env node
/**
 * Attach to a running Chromium over CDP, reload the owleye page, and report
 * console output plus internal state. Debugging aid, not part of the test suite.
 *
 * Usage: node scripts/debug-page.mjs [cdpPort] [seconds]
 */
import { connectCdp, collectConsole } from './cdp.mjs';

const port = Number(process.argv[2] || 9333);
const seconds = Number(process.argv[3] || 20);

const cdp = await connectCdp(port);
const logs = [];
collectConsole(cdp, logs);

await cdp.send('Runtime.enable');
await cdp.send('Log.enable');
await cdp.send('Page.enable');
await cdp.send('Page.reload', { ignoreCache: true });

console.log(`watching the page for ${seconds}s...`);
await new Promise((r) => setTimeout(r, seconds * 1000));

const snapshot = await cdp.evaluate(`(() => {
  const o = window.__owleye;
  if (!o) return { error: 'window.__owleye missing — app.js did not run' };
  const v = document.getElementById('preview');
  return {
    running: o.state.running,
    videoReadyState: v && v.readyState,
    videoSize: v ? v.videoWidth + 'x' + v.videoHeight : null,
    captureSize: o.state.captureW + 'x' + o.state.captureH,
    ringFrames: o.state.ring.length,
    recording: !!o.state.recording,
    eventCount: o.state.eventCount,
    queue: o.state.queue.length,
    fps: document.getElementById('diag-fps').textContent,
    wake: document.getElementById('diag-wake').textContent,
    pill: document.getElementById('state-pill').textContent,
    score: document.getElementById('score-text').textContent,
    threshold: document.getElementById('threshold-text').textContent,
    settings: o.settings,
  };
})()`);

console.log('\n--- page state ---');
console.log(JSON.stringify(snapshot, null, 2));

console.log('\n--- console ---');
for (const entry of logs.slice(-40)) console.log(`[${entry.level}] ${entry.text}`);
if (logs.length === 0) console.log('(nothing logged)');

cdp.close();
process.exit(0);
