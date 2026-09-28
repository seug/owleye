/**
 * Metronome worker.
 *
 * Browsers clamp setInterval in a backgrounded or blacked-out page to roughly
 * one tick per second, which would quietly reduce a surveillance camera to 1
 * FPS. A worker timer keeps firing at the requested rate.
 */
let timer = null;

self.onmessage = (e) => {
  const { type, intervalMs } = e.data;
  if (type === 'start') {
    clearInterval(timer);
    timer = setInterval(() => self.postMessage({ type: 'tick' }), Math.max(20, intervalMs));
  } else if (type === 'stop') {
    clearInterval(timer);
    timer = null;
  }
};
