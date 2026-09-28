/**
 * GIF encoding worker.
 *
 * Encoding a few dozen 320x240 frames takes hundreds of milliseconds. Doing it
 * on the main thread would stall the capture loop exactly while something is
 * happening in front of the camera, so it runs here instead.
 */
import { encodeGif } from './lib/gif.js';

self.onmessage = (e) => {
  const { id, frames, width, height, delay } = e.data;
  try {
    const bytes = encodeGif(
      frames.map((buf) => new Uint8ClampedArray(buf)),
      { width, height, delay },
    );
    self.postMessage({ id, ok: true, buffer: bytes.buffer }, [bytes.buffer]);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.message ? err.message : err) });
  }
};
