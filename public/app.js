/**
 * owleye — browser side.
 *
 * Loop: grab a frame -> analyse it at low resolution -> when enough of the
 * picture changes, take the ring buffer of recent frames plus a few more,
 * encode a GIF (or a single JPEG) and POST it to the local server.
 *
 * Everything that matters for an hours-long run lives here too: the wake-lock
 * stack, the worker metronome that survives a blacked-out screen, and an upload
 * queue that retries instead of dropping evidence.
 */
import { createMotionDetector } from './lib/motion.js';
import { encodeGif } from './lib/gif.js';
import { INTL_LOCALE, isLang, pickLang, translator } from './lib/i18n.js';

// --- Language ------------------------------------------------------------------
//
// ?lang= wins, then the saved choice, then the browser's locale list.

const urlLang = new URL(location.href).searchParams.get('lang');
const savedLang = (() => {
  try {
    return localStorage.getItem('owleye.lang');
  } catch {
    return null;
  }
})();
const lang = isLang(urlLang) ? urlLang : isLang(savedLang) ? savedLang : pickLang(navigator.languages ?? [navigator.language]);
const t = translator(lang);
const LOCALE = INTL_LOCALE[lang];
document.documentElement.lang = lang;
if (isLang(urlLang)) {
  try {
    localStorage.setItem('owleye.lang', urlLang);
  } catch {
    /* ignore */
  }
}

/** Fill every element marked data-i18n / data-i18n-placeholder / data-i18n-aria. */
function applyStaticTranslations() {
  for (const node of document.querySelectorAll('[data-i18n]')) node.textContent = t(node.dataset.i18n);
  for (const node of document.querySelectorAll('[data-i18n-placeholder]')) node.placeholder = t(node.dataset.i18nPlaceholder);
  for (const node of document.querySelectorAll('[data-i18n-aria]')) node.setAttribute('aria-label', t(node.dataset.i18nAria));
}
applyStaticTranslations();
document.getElementById('score-text').textContent = t('meter.motion', { pct: '0.0' });

// --- DOM ---------------------------------------------------------------------

const $ = (id) => document.getElementById(id);

const el = {
  preview: $('preview'),
  overlay: $('overlay'),
  hint: $('viewport-hint'),
  statePill: $('state-pill'),
  serverPill: $('server-pill'),
  meterFill: $('meter-fill'),
  scoreText: $('score-text'),
  thresholdText: $('threshold-text'),
  start: $('btn-start'),
  stop: $('btn-stop'),
  blackoutBtn: $('btn-blackout'),
  test: $('btn-test'),
  blackout: $('blackout'),
  nosleep: $('nosleep'),
  eventList: $('event-list'),
  adaptersLine: $('adapters-line'),
  pushPanel: $('push-panel'),
  pushStatus: $('push-status'),
  pushBtn: $('btn-push'),
  modeRecord: $('mode-record'),
  modeView: $('mode-view'),
  sessionNote: $('session-note'),
  sessionId: $('session-id'),
  copyLink: $('btn-copy-link'),
  copyId: $('btn-copy-id'),
  gotoForm: $('goto-form'),
  gotoId: $('goto-id'),
  ntfyUrl: $('ntfy-url'),
  ntfyTopic: $('ntfy-topic'),
  ntfyToken: $('ntfy-token'),
  ntfySave: $('ntfy-save'),
  ntfyTest: $('ntfy-test'),
  ntfyStatus: $('ntfy-status'),
  langSelect: $('lang-select'),
  diagWake: $('diag-wake'),
  diagFps: $('diag-fps'),
  diagEvents: $('diag-events'),
  diagQueue: $('diag-queue'),
  setDevice: $('set-device'),
  setMode: $('set-mode'),
  setFacing: $('set-facing'),
  setArea: $('set-area'),
  setPixel: $('set-pixel'),
  setClip: $('set-clip'),
  setCooldown: $('set-cooldown'),
  setWidth: $('set-width'),
  setSound: $('set-sound'),
  setBurst: $('set-burst'),
  setBurstFrames: $('set-burst-frames'),
  setBurstGap: $('set-burst-gap'),
  valArea: $('val-area'),
  valPixel: $('val-pixel'),
  valClip: $('val-clip'),
  valCooldown: $('val-cooldown'),
  valWidth: $('val-width'),
  valBurstFrames: $('val-burst-frames'),
  valBurstGap: $('val-burst-gap'),
  burstFields: $('burst-fields'),
};

// --- Settings ----------------------------------------------------------------

const ANALYSIS_WIDTH = 96;
const ANALYSIS_HEIGHT = 72;
const CAPTURE_FPS = 1;
const MAX_CLIP_FRAMES = 60;
const CONFIRM_FRAMES = 2; // consecutive triggered frames before an event fires

const DEFAULTS = {
  device: '',
  mode: 'gif',
  facing: 'user',
  area: 20, // slider units: area/1000 = fraction of frame
  pixel: 22,
  clip: 30, // slider units: clip/10 = seconds
  cooldown: 20,
  width: 320,
  sound: false,
  burst: false, // serial-capture mode: open camera in short bursts, close between
  burstFrames: 8, // stills grabbed per burst window
  burstGap: 10, // seconds the camera stays closed between bursts
};

const settings = loadSettings();

function loadSettings() {
  let stored = {};
  try {
    stored = JSON.parse(localStorage.getItem('owleye.settings') || '{}');
  } catch {
    /* corrupt storage, fall back to defaults */
  }
  const merged = { ...DEFAULTS, ...stored };
  if (!merged.device) merged.device = suggestDeviceName();
  return merged;
}

function saveSettings() {
  try {
    localStorage.setItem('owleye.settings', JSON.stringify(settings));
  } catch {
    /* private mode, ignore */
  }
}

function suggestDeviceName() {
  const ua = navigator.userAgent;
  const kind = /iPhone|Android|iPad/i.test(ua) ? 'phone' : 'mac';
  return `${kind}-${Math.random().toString(36).slice(2, 6)}`;
}

const areaThreshold = () => settings.area / 1000;
const clipSeconds = () => settings.clip / 10;

// --- Runtime state -----------------------------------------------------------

const params = new URL(location.href).searchParams;
const token = params.get('t') || '';

const state = {
  running: false,
  stream: null,
  source: null,
  detector: null,
  ticker: null,
  gifWorker: null,
  ring: [], // recent capture frames (Uint8ClampedArray)
  ringLimit: CAPTURE_FPS,
  recording: null, // { frames, needed, peakScore, startedAt }
  consecutive: 0,
  cooldownUntil: 0,
  eventCount: 0,
  queue: [],
  sending: false,
  frameTimes: [],
  captureW: 320,
  captureH: 240,
  wakeSentinel: null,
  audioCtx: null,
  syntheticTimer: null,
  pendingJobs: new Map(),
  jobSeq: 0,
  burstLoop: null, // { cancelled } handle for the serial-capture cycle
  burstTimer: null, // setTimeout id for the gap between bursts
};

const analysisCanvas = document.createElement('canvas');
analysisCanvas.width = ANALYSIS_WIDTH;
analysisCanvas.height = ANALYSIS_HEIGHT;
const analysisCtx = analysisCanvas.getContext('2d', { willReadFrequently: true });

const captureCanvas = document.createElement('canvas');
const captureCtx = captureCanvas.getContext('2d', { willReadFrequently: true });

// --- UI wiring ---------------------------------------------------------------

function bindSettings() {
  el.setDevice.value = settings.device;
  el.setMode.value = settings.mode;
  el.setFacing.value = settings.facing;
  el.setArea.value = settings.area;
  el.setPixel.value = settings.pixel;
  el.setClip.value = settings.clip;
  el.setCooldown.value = settings.cooldown;
  el.setWidth.value = settings.width;
  el.setSound.checked = settings.sound;
  el.setBurst.checked = settings.burst;
  el.setBurstFrames.value = settings.burstFrames;
  el.setBurstGap.value = settings.burstGap;
  reflectSettings();

  el.setDevice.addEventListener('change', () => {
    settings.device = el.setDevice.value.trim() || suggestDeviceName();
    el.setDevice.value = settings.device;
    saveSettings();
  });

  el.setMode.addEventListener('change', () => {
    settings.mode = el.setMode.value;
    saveSettings();
  });

  el.setFacing.addEventListener('change', async () => {
    settings.facing = el.setFacing.value;
    saveSettings();
    if (state.running) {
      await stopCamera({ keepUi: true });
      await startCamera();
    }
  });

  for (const [input, key] of [
    [el.setArea, 'area'],
    [el.setPixel, 'pixel'],
    [el.setClip, 'clip'],
    [el.setCooldown, 'cooldown'],
    [el.setWidth, 'width'],
  ]) {
    input.addEventListener('input', () => {
      settings[key] = Number(input.value);
      reflectSettings();
      applySensitivity();
      saveSettings();
    });
  }

  el.setSound.addEventListener('change', async () => {
    settings.sound = el.setSound.checked;
    saveSettings();
    if (settings.sound && state.running) await startAudioKeepAlive();
    else stopAudioKeepAlive();
  });

  el.setBurst.addEventListener('change', async () => {
    settings.burst = el.setBurst.checked;
    saveSettings();
    reflectSettings();
    // Switching capture model requires a clean restart of the camera.
    if (state.running) {
      await stopCamera({ keepUi: true });
      await startCamera();
    }
  });

  el.setBurstFrames.addEventListener('input', () => {
    settings.burstFrames = Number(el.setBurstFrames.value);
    saveSettings();
    reflectSettings();
  });

  el.setBurstGap.addEventListener('input', () => {
    settings.burstGap = Number(el.setBurstGap.value);
    saveSettings();
    reflectSettings();
  });
}

function reflectSettings() {
  el.valArea.textContent = `${(areaThreshold() * 100).toFixed(1)}%`;
  el.valPixel.textContent = String(settings.pixel);
  el.valClip.textContent = clipSeconds().toFixed(1);
  el.valCooldown.textContent = String(settings.cooldown);
  el.valWidth.textContent = String(settings.width);
  el.valBurstFrames.textContent = String(settings.burstFrames);
  el.valBurstGap.textContent = String(settings.burstGap);
  el.burstFields.hidden = !settings.burst;
  el.thresholdText.textContent = t('meter.threshold', { pct: (areaThreshold() * 100).toFixed(1) });
}

function applySensitivity() {
  state.detector?.setSensitivity({
    areaThreshold: areaThreshold(),
    pixelThreshold: settings.pixel,
  });
  state.ringLimit = Math.max(2, Math.round(Math.min(1.2, clipSeconds() / 3) * CAPTURE_FPS));
  while (state.ring.length > state.ringLimit) state.ring.shift();
}

function setPill(text, cls) {
  el.statePill.textContent = text;
  el.statePill.className = `pill ${cls}`;
}

// --- Camera ------------------------------------------------------------------

async function startCamera() {
  if (state.running) return;

  if (!navigator.mediaDevices?.getUserMedia) {
    setPill(t('pill.noCamera'), 'pill-alert');
    el.hint.hidden = false;
    el.hint.textContent = window.isSecureContext
      ? t('hint.noApi')
      : t('hint.insecure');
    return;
  }

  // Serial-capture ("burst") mode: instead of holding the stream open — which
  // keeps the camera indicator lit the whole time — open the camera for a short
  // burst of stills, close it so the light goes out, wait, repeat. Sampled, not
  // continuous: motion that happens while the camera is closed is not seen.
  if (settings.burst) {
    await startBurstMode();
    return;
  }

  // ?fakecam=1 swaps the camera for a generated moving scene. Lets you verify
  // the whole chain — detection, encoding, upload, adapters — on a machine with
  // no camera, and is what the end-to-end test drives.
  if (params.get('fakecam') === '1') {
    setPill(t('pill.fakeCamera'), 'pill-idle');
    state.stream = createSyntheticStream();
    await finishCameraStart();
    return;
  }

  setPill(t('pill.requesting'), 'pill-idle');
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: settings.facing,
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 15 },
      },
      audio: false,
    });
  } catch (err) {
    setPill(t('pill.denied'), 'pill-alert');
    el.hint.hidden = false;
    el.hint.textContent = t('hint.openFailed', { err: err.name });
    return;
  }

  await finishCameraStart();
}

/** Shared tail of startCamera: wire up the stream, detector, ticker and UI. */
async function finishCameraStart() {
  const track = state.stream.getVideoTracks()[0];

  el.preview.srcObject = state.stream;
  // Deliberately not awaited: in a hidden or blacked-out page the play()
  // promise can stay pending forever, and waiting on it would stall startup.
  el.preview.play().catch(() => {});

  try {
    state.source = await createFrameSource(state.stream, el.preview);
  } catch (err) {
    setPill(t('pill.noFrames'), 'pill-alert');
    el.hint.hidden = false;
    el.hint.textContent = t('hint.noFrames', { err: err.message });
    state.stream.getTracks().forEach((t) => t.stop());
    state.stream = null;
    return;
  }
  el.hint.hidden = true;

  const s = track.getSettings();
  const ratio = s.height && s.width ? s.height / s.width : 0.75;
  state.captureW = settings.width;
  state.captureH = Math.round((settings.width * ratio) / 2) * 2;
  captureCanvas.width = state.captureW;
  captureCanvas.height = state.captureH;

  state.detector = createMotionDetector({
    width: ANALYSIS_WIDTH,
    height: ANALYSIS_HEIGHT,
    pixelThreshold: settings.pixel,
    areaThreshold: areaThreshold(),
    warmupFrames: 10,
  });
  applySensitivity();

  state.ring = [];
  state.recording = null;
  state.consecutive = 0;
  state.cooldownUntil = 0;
  state.running = true;

  startTicker();
  await enableWakeLock();
  if (settings.sound) await startAudioKeepAlive();

  el.start.disabled = true;
  el.stop.disabled = false;
  el.blackoutBtn.disabled = false;
  setPill(t('pill.watching'), 'pill-live');
  track.addEventListener('ended', () => {
    if (state.running) {
      setPill(t('pill.cameraLost'), 'pill-alert');
      stopCamera();
    }
  });
}

/**
 * Synthetic camera for ?fakecam=1: a dim room with a figure walking across it,
 * captured off a canvas. Same MediaStream shape as a real camera, so every later
 * stage is exercised for real.
 */
function createSyntheticStream() {
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 480;
  const ctx = canvas.getContext('2d');
  let t = 0;

  const paint = () => {
    ctx.fillStyle = '#23262e';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Static furniture, so the scene is not uniformly flat.
    ctx.fillStyle = '#31353f';
    ctx.fillRect(40, 300, 180, 140);
    ctx.fillRect(470, 250, 130, 190);

    // Sensor noise.
    for (let i = 0; i < 900; i++) {
      ctx.fillStyle = `rgba(255,255,255,${Math.random() * 0.05})`;
      ctx.fillRect(Math.random() * canvas.width, Math.random() * canvas.height, 2, 2);
    }

    // A figure crossing the frame every ~8 seconds.
    const cycle = (t % 80) / 80;
    const x = cycle * (canvas.width + 120) - 60;
    ctx.fillStyle = '#d8c9a8';
    ctx.fillRect(x, 190, 56, 190);
    ctx.beginPath();
    ctx.arc(x + 28, 168, 26, 0, Math.PI * 2);
    ctx.fill();

    t++;
  };

  paint();
  state.syntheticTimer = setInterval(paint, 100);
  return canvas.captureStream(10);
}

/**
 * Frame source.
 *
 * Preferred path is MediaStreamTrackProcessor: it pulls frames straight off the
 * track, so capture keeps working when the page is hidden, blacked out or not
 * being composited at all. A <video> element only decodes while it is being
 * rendered, which is exactly the situation a stealth camera runs in.
 *
 * Safari and older browsers have no track processor, so the video element
 * remains the fallback.
 */
async function createFrameSource(stream, video) {
  const track = stream.getVideoTracks()[0];

  if ('MediaStreamTrackProcessor' in window) {
    try {
      const processor = new window.MediaStreamTrackProcessor({ track });
      const reader = processor.readable.getReader();
      let latest = null;
      let closed = false;

      const pump = (async () => {
        while (!closed) {
          const { value, done } = await reader.read();
          if (done) break;
          latest?.close();
          latest = value;
        }
      })();
      pump.catch(() => {});

      const source = {
        kind: 'track',
        ready: () => latest !== null,
        current: () => latest,
        close: () => {
          closed = true;
          reader.cancel().catch(() => {});
          latest?.close();
          latest = null;
        },
      };

      await waitFor(() => source.ready(), 8000, t('err.noFrames')).catch((err) => {
        source.close();
        throw err;
      });
      return source;
    } catch (err) {
      console.warn('track processor unavailable, falling back to <video>', err);
    }
  }

  await waitFor(() => video.readyState >= 2 && video.videoWidth > 0, 8000, t('err.noDecode'));
  return {
    kind: 'video',
    ready: () => video.readyState >= 2,
    current: () => video,
    close: () => {},
  };
}

function waitFor(predicate, timeoutMs, message) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error(message));
      setTimeout(poll, 100);
    };
    poll();
  });
}

async function stopCamera({ keepUi = false } = {}) {
  state.running = false;
  if (state.burstLoop) state.burstLoop.cancelled = true;
  state.burstLoop = null;
  clearTimeout(state.burstTimer);
  state.burstTimer = null;
  stopTicker();
  state.source?.close();
  state.source = null;
  clearInterval(state.syntheticTimer);
  state.syntheticTimer = null;
  state.stream?.getTracks().forEach((t) => t.stop());
  state.stream = null;
  el.preview.srcObject = null;
  await releaseWakeLock();
  stopAudioKeepAlive();
  clearOverlay();

  if (!keepUi) {
    el.start.disabled = false;
    el.stop.disabled = true;
    el.blackoutBtn.disabled = true;
    el.hint.hidden = false;
    el.hint.textContent = t('hint.stopped');
    setPill(t('pill.stopped'), 'pill-idle');
    el.diagFps.textContent = '—';
  }
}

// --- Serial capture (burst) mode ---------------------------------------------

/** Open the camera for one burst, honouring ?fakecam=1 for tests. */
async function acquireBurstStream() {
  if (params.get('fakecam') === '1') return createSyntheticStream();
  return navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: settings.facing,
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 15 },
    },
    audio: false,
  });
}

/**
 * Start the burst cycle: a detector that persists across bursts (so a change
 * that happened while the camera was closed still registers on the next burst),
 * plus the wake-lock stack so the loop survives a blacked-out screen.
 */
async function startBurstMode() {
  state.detector = createMotionDetector({
    width: ANALYSIS_WIDTH,
    height: ANALYSIS_HEIGHT,
    pixelThreshold: settings.pixel,
    areaThreshold: areaThreshold(),
    warmupFrames: 2,
  });
  state.cooldownUntil = 0;
  state.running = true;

  const loop = { cancelled: false };
  state.burstLoop = loop;

  el.start.disabled = true;
  el.stop.disabled = false;
  el.blackoutBtn.disabled = false; // blackout is about the screen, not the preview
  el.hint.hidden = true;
  await enableWakeLock();
  if (settings.sound) await startAudioKeepAlive();

  setPill(t('pill.burstMode'), 'pill-live');
  runBurstCycle(loop); // self-reschedules; not awaited
}

/** One burst: open camera, grab N stills, close camera, send if anything moved. */
async function runBurstCycle(loop) {
  if (loop.cancelled || !state.running) return;

  const interval = Math.round(1000 / CAPTURE_FPS);
  const count = Math.max(2, Math.round(settings.burstFrames));
  const startedAt = Date.now();
  const frames = [];
  let peak = 0;
  let moved = false;
  let stream = null;
  let source = null;

  try {
    setPill(t('pill.burstShooting'), 'pill-alert');
    stream = await acquireBurstStream();
    el.preview.srcObject = stream; // needed for the <video> fallback path
    el.preview.play().catch(() => {});
    source = await createFrameSource(stream, el.preview);

    const track = stream.getVideoTracks()[0];
    const s = track.getSettings();
    const ratio = s.height && s.width ? s.height / s.width : 0.75;
    state.captureW = settings.width;
    state.captureH = Math.round((settings.width * ratio) / 2) * 2;
    captureCanvas.width = state.captureW;
    captureCanvas.height = state.captureH;

    for (let i = 0; i < count && !loop.cancelled; i++) {
      const frame = source.ready() ? source.current() : null;
      if (frame) {
        analysisCtx.drawImage(frame, 0, 0, ANALYSIS_WIDTH, ANALYSIS_HEIGHT);
        const analysis = analysisCtx.getImageData(0, 0, ANALYSIS_WIDTH, ANALYSIS_HEIGHT);
        const result = state.detector.update(analysis.data);

        captureCtx.drawImage(frame, 0, 0, state.captureW, state.captureH);
        stampFrame(captureCtx, state.captureW, state.captureH);
        frames.push(captureCtx.getImageData(0, 0, state.captureW, state.captureH).data);

        if (!result.warming) {
          peak = Math.max(peak, result.score);
          if (result.moved) moved = true;
        }
        paintMeter(result);
      }
      await sleep(interval);
    }
  } catch (err) {
    console.error('burst cycle failed', err);
    setPill(t('pill.burstFailed', { err: err.name || err.message }), 'pill-alert');
  } finally {
    // Close the camera first — this is what puts the indicator light out.
    source?.close();
    clearInterval(state.syntheticTimer);
    state.syntheticTimer = null;
    stream?.getTracks().forEach((t) => t.stop());
    el.preview.srcObject = null;
  }

  if (!loop.cancelled && state.running && moved && Date.now() >= state.cooldownUntil) {
    state.cooldownUntil = Date.now() + settings.cooldown * 1000;
    setPill(t('pill.motionSending'), 'pill-alert');
    state.eventCount++;
    el.diagEvents.textContent = String(state.eventCount);
    await dispatchClip(frames, peak, startedAt, 'motion');
  }

  if (loop.cancelled || !state.running) return;
  setPill(t('pill.burstPause', { s: settings.burstGap }), 'pill-idle');
  state.burstTimer = setTimeout(() => runBurstCycle(loop), Math.max(0, settings.burstGap * 1000));
}

// --- Capture loop ------------------------------------------------------------

function startTicker() {
  const interval = Math.round(1000 / CAPTURE_FPS);
  try {
    state.ticker = new Worker('/worker-ticker.js');
    state.ticker.onmessage = () => tick();
    state.ticker.postMessage({ type: 'start', intervalMs: interval });
  } catch {
    // Worker blocked (e.g. file://). Main-thread timer: throttled when hidden,
    // but still works while the page is in front.
    state.ticker = { fallback: setInterval(tick, interval) };
  }
}

function stopTicker() {
  if (!state.ticker) return;
  if (state.ticker.fallback) clearInterval(state.ticker.fallback);
  else {
    state.ticker.postMessage({ type: 'stop' });
    state.ticker.terminate();
  }
  state.ticker = null;
}

function tick() {
  if (!state.running || !state.source?.ready()) return;
  const frame = state.source.current();

  const now = performance.now();
  state.frameTimes.push(now);
  if (state.frameTimes.length > 12) state.frameTimes.shift();
  if (state.frameTimes.length > 2) {
    const span = state.frameTimes[state.frameTimes.length - 1] - state.frameTimes[0];
    el.diagFps.textContent = t('diag.fps', { n: ((state.frameTimes.length - 1) / (span / 1000)).toFixed(1) });
  }

  // 1. Analysis frame (tiny, greyscale-friendly).
  analysisCtx.drawImage(frame, 0, 0, ANALYSIS_WIDTH, ANALYSIS_HEIGHT);
  const analysis = analysisCtx.getImageData(0, 0, ANALYSIS_WIDTH, ANALYSIS_HEIGHT);
  const result = state.detector.update(analysis.data);

  // 2. Capture frame with a burned-in timestamp, kept in a ring buffer.
  captureCtx.drawImage(frame, 0, 0, state.captureW, state.captureH);
  stampFrame(captureCtx, state.captureW, state.captureH);
  const captured = captureCtx.getImageData(0, 0, state.captureW, state.captureH).data;

  if (state.recording) {
    state.recording.frames.push(captured);
    state.recording.peakScore = Math.max(state.recording.peakScore, result.score);
    if (state.recording.frames.length >= state.recording.needed) finishRecording();
  } else {
    state.ring.push(captured);
    while (state.ring.length > state.ringLimit) state.ring.shift();
  }

  paintMeter(result);
  drawOverlay(result);

  if (result.warming) {
    setPill(t('pill.settling'), 'pill-idle');
    return;
  }
  if (state.running && el.statePill.textContent === t('pill.settling')) setPill(t('pill.watching'), 'pill-live');

  // 3. Trigger.
  if (result.moved) {
    state.consecutive++;
    if (state.consecutive >= CONFIRM_FRAMES && !state.recording && Date.now() >= state.cooldownUntil) {
      beginRecording(result.score);
    }
  } else {
    state.consecutive = 0;
  }
}

function beginRecording(score) {
  const totalFrames = Math.min(MAX_CLIP_FRAMES, Math.round(clipSeconds() * CAPTURE_FPS));
  const pre = state.ring.slice(-Math.min(state.ring.length, state.ringLimit));
  const needed = Math.max(2, totalFrames - pre.length);

  state.recording = { frames: pre.concat([]), needed: pre.length + needed, peakScore: score, startedAt: Date.now() };
  setPill(t('pill.motionRecording'), 'pill-alert');
}

async function finishRecording() {
  const rec = state.recording;
  state.recording = null;
  state.consecutive = 0;
  state.cooldownUntil = Date.now() + settings.cooldown * 1000;
  state.ring = [];
  if (state.running) setPill(t('pill.watching'), 'pill-live');
  await dispatchClip(rec.frames, rec.peakScore, rec.startedAt, 'motion');
}

/**
 * Encode a set of capture frames and hand them to the upload queue. Shared by
 * the continuous ticker path and the serial-capture (burst) path. In photo mode
 * a single JPEG is sent; otherwise the frames are encoded as a GIF.
 */
async function dispatchClip(frames, peakScore, startedAt, kind) {
  if (!frames || frames.length === 0) return;

  const meta = {
    device: settings.device,
    kind,
    at: new Date(startedAt).toISOString(),
    score: Number(peakScore.toFixed(4)),
    frames: frames.length,
    width: state.captureW,
    height: state.captureH,
  };

  try {
    if (settings.mode === 'photo') {
      const blob = await snapshotJpeg(frames[Math.floor(frames.length / 2)]);
      enqueue({ body: await blob.arrayBuffer(), mime: 'image/jpeg', meta: { ...meta, frames: 1 } });
    } else {
      const bytes = await encodeClip(frames, state.captureW, state.captureH);
      enqueue({ body: bytes.buffer ?? bytes, mime: 'image/gif', meta });
    }
  } catch (err) {
    console.error('encoding failed', err);
    setPill(t('pill.encodeFailed', { err: err.message }), 'pill-alert');
  }
}

/** Encode in the worker, falling back to the main thread if workers are unavailable. */
function encodeClip(frames, width, height) {
  const delay = Math.round(1000 / CAPTURE_FPS);

  if (!state.gifWorker) {
    try {
      state.gifWorker = new Worker('/worker-gif.js', { type: 'module' });
      state.gifWorker.onmessage = (e) => {
        const job = state.pendingJobs.get(e.data.id);
        if (!job) return;
        state.pendingJobs.delete(e.data.id);
        if (e.data.ok) job.resolve(new Uint8Array(e.data.buffer));
        else job.reject(new Error(e.data.error));
      };
      state.gifWorker.onerror = () => {
        state.gifWorker = 'unavailable';
      };
    } catch {
      state.gifWorker = 'unavailable';
    }
  }

  if (state.gifWorker === 'unavailable') {
    return Promise.resolve(encodeGif(frames, { width, height, delay }));
  }

  const id = ++state.jobSeq;
  const buffers = frames.map((f) => f.buffer);
  return new Promise((resolve, reject) => {
    state.pendingJobs.set(id, { resolve, reject });
    state.gifWorker.postMessage({ id, frames: buffers, width, height, delay }, buffers);
    setTimeout(() => {
      if (state.pendingJobs.delete(id)) reject(new Error(t('err.encodeTimeout')));
    }, 30000);
  });
}

function snapshotJpeg(frameData) {
  const c = document.createElement('canvas');
  c.width = state.captureW;
  c.height = state.captureH;
  const ctx = c.getContext('2d');
  ctx.putImageData(new ImageData(frameData, state.captureW, state.captureH), 0, 0);
  return new Promise((resolve) => c.toBlob(resolve, 'image/jpeg', 0.82));
}

/** Burn device name and wall-clock time into the frame — an unstamped clip proves less. */
function stampFrame(ctx, width, height) {
  const text = `${settings.device}  ${new Date().toLocaleString('ru-RU', { hour12: false })}`;
  const fontSize = Math.max(10, Math.round(width / 28));
  ctx.font = `600 ${fontSize}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  const padding = Math.round(fontSize * 0.4);
  const metrics = ctx.measureText(text);
  const boxH = fontSize + padding * 2;
  ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
  ctx.fillRect(0, height - boxH, metrics.width + padding * 2, boxH);
  ctx.fillStyle = '#ffffff';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, padding, height - boxH / 2 + 1);
}

// --- Overlay and meter -------------------------------------------------------

function paintMeter(result) {
  const pct = Math.min(100, (result.score / Math.max(areaThreshold() * 2, 0.001)) * 100);
  el.meterFill.style.width = `${pct}%`;
  el.meterFill.classList.toggle('hot', result.moved);
  el.scoreText.textContent = t('meter.motion', { pct: (result.score * 100).toFixed(1) });
}

function drawOverlay(result) {
  const canvas = el.overlay;
  const rect = el.preview.getBoundingClientRect();
  if (canvas.width !== Math.round(rect.width) || canvas.height !== Math.round(rect.height)) {
    canvas.width = Math.max(1, Math.round(rect.width));
    canvas.height = Math.max(1, Math.round(rect.height));
  }
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!result.bbox || !result.moved) return;

  const sx = canvas.width / ANALYSIS_WIDTH;
  const sy = canvas.height / ANALYSIS_HEIGHT;
  ctx.strokeStyle = '#ff5f56';
  ctx.lineWidth = 2;
  ctx.strokeRect(result.bbox.x * sx, result.bbox.y * sy, result.bbox.w * sx, result.bbox.h * sy);
}

function clearOverlay() {
  const ctx = el.overlay.getContext('2d');
  ctx.clearRect(0, 0, el.overlay.width, el.overlay.height);
  el.meterFill.style.width = '0%';
}

// --- Upload queue ------------------------------------------------------------

function enqueue(job) {
  job.attempts = 0;
  state.queue.push(job);
  if (state.queue.length > 20) state.queue.shift();
  el.diagQueue.textContent = String(state.queue.length);
  pump();
}

async function pump() {
  if (state.sending || state.queue.length === 0) return;
  state.sending = true;

  while (state.queue.length) {
    const job = state.queue[0];
    try {
      const res = await fetch('/api/event', {
        method: 'POST',
        headers: {
          'content-type': job.mime,
          'x-owleye-meta': toBase64Json(job.meta),
          ...(token ? { 'x-owleye-token': token } : {}),
        },
        body: job.body,
      });
      if (!res.ok) throw new Error(t('err.server', { status: res.status }));
      state.queue.shift();
      state.eventCount++;
      el.diagEvents.textContent = String(state.eventCount);
      el.serverPill.textContent = t('pill.serverOk');
      el.serverPill.className = 'pill pill-muted';
    } catch (err) {
      job.attempts++;
      el.serverPill.textContent = t('pill.serverDown', { n: job.attempts });
      el.serverPill.className = 'pill pill-alert';
      if (job.attempts >= 5) {
        console.error('dropping event after 5 attempts', err);
        state.queue.shift();
      } else {
        await sleep(Math.min(15000, 1500 * job.attempts));
      }
    }
    el.diagQueue.textContent = String(state.queue.length);
  }

  state.sending = false;
}

function toBase64Json(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Staying awake -----------------------------------------------------------

/**
 * Screen Wake Lock API, per
 * https://developer.mozilla.org/en-US/docs/Web/API/Screen_Wake_Lock_API
 * The lock is dropped by the system whenever the document is hidden, so it has
 * to be re-acquired on visibilitychange — over a night-long run this fires
 * constantly.
 */
async function enableWakeLock() {
  if (!('wakeLock' in navigator)) {
    el.diagWake.textContent = t('diag.videoHack');
    playNoSleepVideo();
    return;
  }
  try {
    state.wakeSentinel = await navigator.wakeLock.request('screen');
    el.diagWake.textContent = 'wake lock';
    state.wakeSentinel.addEventListener('release', () => {
      el.diagWake.textContent = state.running ? t('diag.reacquire') : '—';
    });
  } catch (err) {
    el.diagWake.textContent = t('diag.videoHack');
    console.warn('wake lock refused', err);
    playNoSleepVideo();
  }
}

async function releaseWakeLock() {
  try {
    await state.wakeSentinel?.release();
  } catch {
    /* already gone */
  }
  state.wakeSentinel = null;
  el.nosleep.pause();
  el.diagWake.textContent = '—';
}

document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && state.running) {
    await enableWakeLock();
  }
});

/** Fallback for browsers without the wake lock: a muted looping video. */
function playNoSleepVideo() {
  el.nosleep.play().catch(() => {
    el.diagWake.textContent = t('diag.mayDim');
  });
}

/**
 * A silent audio graph keeps the tab classed as "playing", which stops the
 * browser from throttling it in the background. Needs a user gesture, so it is
 * started from the Start button.
 */
async function startAudioKeepAlive() {
  if (state.audioCtx) return;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    gain.gain.value = 0.0008; // inaudible, but not digital silence
    osc.frequency.value = 40;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    await ctx.resume();
    state.audioCtx = { ctx, osc };
  } catch (err) {
    console.warn('audio keep-alive unavailable', err);
  }
}

function stopAudioKeepAlive() {
  if (!state.audioCtx) return;
  try {
    state.audioCtx.osc.stop();
    state.audioCtx.ctx.close();
  } catch {
    /* ignore */
  }
  state.audioCtx = null;
}

// --- Blackout (stealth) ------------------------------------------------------

let blackoutTaps = 0;
let blackoutTapTimer = null;

function enterBlackout() {
  el.blackout.hidden = false;
  requestAnimationFrame(() => el.blackout.classList.add('settled'));
  document.documentElement.requestFullscreen?.().catch(() => {});
}

function exitBlackout() {
  el.blackout.hidden = true;
  el.blackout.classList.remove('settled');
  blackoutTaps = 0;
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
}

el.blackout.addEventListener('pointerdown', () => {
  blackoutTaps++;
  clearTimeout(blackoutTapTimer);
  blackoutTapTimer = setTimeout(() => {
    blackoutTaps = 0;
  }, 1200);
  if (blackoutTaps >= 3) exitBlackout();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !el.blackout.hidden) exitBlackout();
});

// --- Server feed -------------------------------------------------------------

function renderEvent(event) {
  const empty = el.eventList.querySelector('.empty');
  if (empty) empty.remove();

  const li = document.createElement('li');
  li.className = `event kind-${event.kind}`;

  if (event.mediaUrl) {
    const img = document.createElement('img');
    img.src = event.mediaUrl + (token ? `?t=${encodeURIComponent(token)}` : '');
    img.alt = `${event.kind} ${event.at}`;
    img.loading = 'lazy';
    // The media may be gone (pruned, moved, disk cleared) — drop the thumbnail
    // rather than leaving a broken image in the evidence list.
    img.addEventListener('error', () => img.remove());
    li.append(img);
  }

  const meta = document.createElement('div');
  meta.className = 'event-meta';
  const title = document.createElement('b');
  title.textContent =
    event.kind === 'motion'
      ? t('feed.motion', { device: event.device })
      : event.kind === 'offline'
        ? t('feed.offline', { device: event.device })
        : event.kind === 'online'
          ? t('feed.online', { device: event.device })
          : t('feed.other', { kind: event.kind, device: event.device });
  meta.append(title);

  const line = document.createElement('div');
  const bits = [new Date(event.at).toLocaleTimeString(LOCALE, { hour12: false })];
  if (typeof event.score === 'number') bits.push(`${(event.score * 100).toFixed(1)}%`);
  if (event.bytes) bits.push(t('feed.kb', { n: Math.round(event.bytes / 1024) }));
  line.textContent = bits.join(' · ');
  meta.append(line);

  const failed = (event.adapters || []).filter((a) => !a.ok);
  if (failed.length) {
    const warn = document.createElement('div');
    warn.className = 'fail';
    warn.textContent = t('feed.notDelivered', { names: failed.map((f) => f.name).join(', ') });
    meta.append(warn);
  }

  li.append(meta);
  el.eventList.prepend(li);
  while (el.eventList.children.length > 30) el.eventList.lastElementChild.remove();
}

function connectFeed() {
  const url = `/api/stream${token ? `?t=${encodeURIComponent(token)}` : ''}`;
  const source = new EventSource(url);
  source.onmessage = (e) => {
    try {
      renderEvent(JSON.parse(e.data));
    } catch {
      /* ignore malformed frame */
    }
  };
  source.onerror = () => {
    el.serverPill.textContent = t('pill.streamLost');
    el.serverPill.className = 'pill pill-alert';
  };
  source.onopen = () => {
    el.serverPill.textContent = t('pill.serverOk');
    el.serverPill.className = 'pill pill-muted';
  };
}

async function loadServerInfo() {
  try {
    const res = await fetch(`/api/config`, { headers: token ? { 'x-owleye-token': token } : {} });
    const cfg = await res.json();
    el.adaptersLine.textContent = cfg.adapters?.length
      ? t('foot.adapters', { names: cfg.adapters.join(', ') })
      : t('foot.noAdapters');
    setupPush(cfg).catch((err) => setPushStatus(t('push.unavailable', { err: err.message }), 'off'));
    setupSession(cfg);
    const events = await (await fetch(`/api/events?limit=12`, { headers: token ? { 'x-owleye-token': token } : {} })).json();
    (events.events || []).slice().reverse().forEach(renderEvent);
  } catch {
    el.adaptersLine.textContent = t('foot.serverDown');
  }
}

function startHeartbeat() {
  const beat = async () => {
    if (!state.running) return;
    try {
      await fetch('/api/heartbeat', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { 'x-owleye-token': token } : {}) },
        body: JSON.stringify({
          device: settings.device,
          mode: settings.mode,
          area: areaThreshold(),
          userAgent: navigator.userAgent,
        }),
      });
    } catch {
      /* the queue reports connectivity problems already */
    }
  };
  beat();
  setInterval(beat, 30000);
}

// --- Web Push: alerts to this device with the tab closed ----------------------
//
// The server signs pushes with its VAPID key (exposed in /api/config). The
// browser hands us an endpoint at its vendor's push service; we store it on the
// server, and the service worker (/sw.js) shows whatever arrives.

const push = { publicKey: null, registration: null, subscription: null };

function setPushStatus(text, tone = '') {
  el.pushStatus.textContent = text;
  el.pushStatus.className = tone;
}

function urlBase64ToBytes(b64) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

function sameKey(a, b) {
  if (!a || !b) return false;
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

async function setupPush(cfg) {
  if (!cfg.pushPublicKey) {
    el.pushPanel.hidden = true;
    return;
  }
  el.pushPanel.hidden = false;
  push.publicKey = cfg.pushPublicKey;

  const ios = /iP(hone|ad|od)/.test(navigator.userAgent);
  const standalone = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
  if (!window.isSecureContext) {
    setPushStatus(t('push.needHttps'), 'off');
    return;
  }
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    setPushStatus(
      ios && !standalone
        ? t('push.iosHint')
        : t('push.unsupported'),
      'off',
    );
    return;
  }

  push.registration = await navigator.serviceWorker.register('/sw.js');
  push.subscription = await push.registration.pushManager.getSubscription();

  // The server key changed (new data dir, keys rotated) — the old subscription is dead.
  if (push.subscription && !sameKey(push.subscription.options?.applicationServerKey, urlBase64ToBytes(push.publicKey))) {
    await push.subscription.unsubscribe().catch(() => {});
    push.subscription = null;
  }
  reflectPush();
}

function reflectPush() {
  el.pushBtn.disabled = false;
  if (push.subscription) {
    el.pushBtn.textContent = t('push.disable');
    setPushStatus(t('push.on'), 'on');
  } else if (Notification.permission === 'denied') {
    el.pushBtn.disabled = true;
    setPushStatus(t('push.denied'), 'off');
  } else {
    el.pushBtn.textContent = t('push.enable');
    setPushStatus(t('push.off'));
  }
}

async function pushApi(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { 'x-owleye-token': token } : {}) },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

async function enablePush() {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    reflectPush();
    return;
  }
  const subscription = await push.registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToBytes(push.publicKey),
  });
  try {
    const label = `${settings.device || 'browser'} · ${navigator.userAgent.slice(0, 80)}`;
    await pushApi('/api/push/subscribe', { subscription: subscription.toJSON(), label });
  } catch (err) {
    await subscription.unsubscribe().catch(() => {});
    throw err;
  }
  push.subscription = subscription;
}

async function disablePush() {
  const endpoint = push.subscription.endpoint;
  await push.subscription.unsubscribe().catch(() => {});
  push.subscription = null;
  await pushApi('/api/push/unsubscribe', { endpoint });
}

el.pushBtn.addEventListener('click', async () => {
  el.pushBtn.disabled = true;
  setPushStatus(push.subscription ? t('push.disabling') : t('push.subscribing'));
  try {
    if (push.subscription) await disablePush();
    else await enablePush();
    reflectPush();
  } catch (err) {
    reflectPush();
    setPushStatus(t('push.failed', { err: err.message }), 'off');
  }
});

// --- Session: who this device belongs to, and the record / view switch --------
//
// A session is an isolated owleye: own feed, clips, push and ntfy. The id is
// the key. "Камера" runs the detector on this device; "Просмотр" is the same
// session without the camera — for the phone that only watches.

const sessionState = { token: '', link: '', langSent: '' };

function authHeaders(extra = {}) {
  return { ...(token ? { 'x-owleye-token': token } : {}), ...extra };
}

async function api(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify(body ?? {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

function currentMode() {
  const fromUrl = params.get('mode');
  if (fromUrl === 'view' || fromUrl === 'record') return fromUrl;
  return localStorage.getItem('owleye.mode') === 'view' ? 'view' : 'record';
}

function applyMode(mode) {
  const view = mode === 'view';
  document.body.classList.toggle('mode-view', view);
  el.modeRecord.classList.toggle('active', !view);
  el.modeView.classList.toggle('active', view);
  el.modeRecord.setAttribute('aria-selected', String(!view));
  el.modeView.setAttribute('aria-selected', String(view));
  try {
    localStorage.setItem('owleye.mode', mode);
  } catch {
    /* ignore */
  }
  if (view && state.running) stopCamera();
}

el.langSelect.value = lang;
el.langSelect.addEventListener('change', () => {
  try {
    localStorage.setItem('owleye.lang', el.langSelect.value);
  } catch {
    /* ignore */
  }
  const url = new URL(location.href);
  url.searchParams.set('lang', el.langSelect.value);
  location.href = url.href;
});

el.modeRecord.addEventListener('click', () => applyMode('record'));
el.modeView.addEventListener('click', () => applyMode('view'));
applyMode(currentMode());

function setupSession(cfg) {
  const s = cfg.session;
  // Server-side texts (notifications, event notes) follow the session's language.
  if (s.lang !== lang && sessionState.langSent !== lang) {
    sessionState.langSent = lang;
    api('/api/session', { lang }).catch(() => {});
  }
  sessionState.token = cfg.token || '';
  sessionState.link = sessionState.token ? `${location.origin}/?t=${encodeURIComponent(sessionState.token)}` : location.origin;
  el.sessionId.textContent = s.isDefault ? t('session.default') : s.id;
  el.sessionNote.textContent = s.isDefault
    ? t('session.defaultNote')
    : t('session.created', { when: new Date(s.createdAt).toLocaleString(LOCALE, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) });
  el.copyLink.disabled = el.copyId.disabled = !sessionState.token;

  el.ntfyUrl.value = s.ntfy.url || '';
  el.ntfyTopic.value = s.ntfy.topic || '';
  el.ntfyToken.value = '';
  el.ntfyToken.placeholder = s.ntfy.tokenSet ? t('ntfy.tokenSet') : t('ntfy.tokenOptional');
  el.ntfyStatus.textContent = s.ntfy.topic ? t('ntfy.on', { url: `${s.ntfy.url}/${s.ntfy.topic}` }) : t('ntfy.off');
}

async function copyText(text, button, done) {
  const original = button.textContent;
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = done;
  } catch {
    // No clipboard API (http page, old WebView): select the id so a long press copies it.
    const range = document.createRange();
    range.selectNodeContents(el.sessionId);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    button.textContent = t('session.selected');
  }
  setTimeout(() => (button.textContent = original), 1800);
}

el.copyLink.addEventListener('click', () => copyText(sessionState.link, el.copyLink, t('session.linkCopied')));
el.copyId.addEventListener('click', () => copyText(sessionState.token, el.copyId, t('session.idCopied')));

el.gotoForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const id = el.gotoId.value.trim();
  if (!id) return;
  // The server swaps the cookie for the new id; this device now belongs to that session.
  location.href = `/?t=${encodeURIComponent(id)}&mode=view`;
});

el.ntfySave.addEventListener('click', async () => {
  el.ntfySave.disabled = true;
  el.ntfyStatus.textContent = t('ntfy.saving');
  try {
    const ntfy = { url: el.ntfyUrl.value.trim(), topic: el.ntfyTopic.value.trim() };
    if (el.ntfyToken.value) ntfy.token = el.ntfyToken.value;
    const { session } = await api('/api/session', { ntfy });
    setupSession({ session, token: sessionState.token });
    el.ntfyStatus.textContent = session.ntfy.topic ? t('ntfy.savedOn', { url: `${session.ntfy.url}/${session.ntfy.topic}` }) : t('ntfy.savedOff');
  } catch (err) {
    el.ntfyStatus.textContent = t('ntfy.saveFailed', { err: err.message });
  } finally {
    el.ntfySave.disabled = false;
  }
});

el.ntfyTest.addEventListener('click', async () => {
  el.ntfyTest.disabled = true;
  el.ntfyStatus.textContent = t('ntfy.testing');
  try {
    const { event } = await api('/api/test');
    const ntfy = (event?.adapters || []).find((a) => a.name === 'ntfy');
    el.ntfyStatus.textContent = !ntfy
      ? t('ntfy.testNoAdapter')
      : ntfy.ok
        ? t('ntfy.testSent')
        : t('ntfy.testError', { err: ntfy.error });
  } catch (err) {
    el.ntfyStatus.textContent = t('ntfy.testFailed', { err: err.message });
  } finally {
    el.ntfyTest.disabled = false;
  }
});

// --- Buttons -----------------------------------------------------------------

el.start.addEventListener('click', async () => {
  await startAudioKeepAlive().catch(() => {});
  if (!settings.sound) stopAudioKeepAlive();
  await startCamera();
});

el.stop.addEventListener('click', () => stopCamera());
el.blackoutBtn.addEventListener('click', enterBlackout);

el.test.addEventListener('click', async () => {
  el.test.disabled = true;
  try {
    const res = await fetch('/api/test', { method: 'POST', headers: token ? { 'x-owleye-token': token } : {} });
    const body = await res.json();
    const failed = (body.event?.adapters || []).filter((a) => !a.ok);
    el.adaptersLine.textContent = failed.length
      ? t('test.failed', { details: failed.map((f) => `${f.name} (${f.error})`).join('; ') })
      : t('test.delivered', { names: (body.event?.adapters || []).map((a) => a.name).join(', ') || t('test.noAdapters') });
  } catch (err) {
    el.adaptersLine.textContent = t('test.error', { err: err.message });
  } finally {
    el.test.disabled = false;
  }
});

window.addEventListener('beforeunload', () => {
  state.stream?.getTracks().forEach((t) => t.stop());
});

// --- Boot --------------------------------------------------------------------

bindSettings();
loadServerInfo();
connectFeed();
startHeartbeat();

// ?autostart=1 lets the machine resume watching after a reboot or a reload,
// and is what the end-to-end test uses with a fake camera.
if (params.get('autostart') === '1') {
  startCamera();
}

// Exposed for the end-to-end test, which needs to assert on internals.
window.__owleye = { state, settings, startCamera, stopCamera };
