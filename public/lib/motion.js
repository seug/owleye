/**
 * Frame-difference motion detector.
 *
 * Isomorphic and allocation-free on the hot path, so it runs in the browser at
 * analysis FPS and in the Node self-test on synthetic frames.
 *
 * Method: RGBA -> luma -> 3x3 box blur (kills sensor noise, which is the main
 * source of false positives in a dim hotel room) -> absolute difference against
 * the previous blurred frame -> fraction of pixels above `pixelThreshold`.
 */

/**
 * @param {object} opts
 * @param {number} opts.width analysis width (small, e.g. 96)
 * @param {number} opts.height analysis height (e.g. 72)
 * @param {number} [opts.pixelThreshold=22] per-pixel luma delta counted as change (0-255)
 * @param {number} [opts.areaThreshold=0.02] fraction of changed pixels that counts as motion
 * @param {number} [opts.warmupFrames=8] frames ignored after start / after settings change
 */
export function createMotionDetector(opts) {
  const width = opts.width;
  const height = opts.height;
  const size = width * height;

  let pixelThreshold = opts.pixelThreshold ?? 22;
  let areaThreshold = opts.areaThreshold ?? 0.02;
  const warmupFrames = opts.warmupFrames ?? 8;

  const gray = new Uint8ClampedArray(size);
  const tmp = new Uint8ClampedArray(size);
  const blurred = new Uint8ClampedArray(size);
  const previous = new Uint8ClampedArray(size);

  let seen = 0;

  return {
    width,
    height,

    setSensitivity({ pixelThreshold: p, areaThreshold: a }) {
      if (typeof p === 'number') pixelThreshold = p;
      if (typeof a === 'number') areaThreshold = a;
    },

    /** Forget history, e.g. after the camera restarts. */
    reset() {
      seen = 0;
    },

    /**
     * @param {Uint8ClampedArray} rgba width*height*4 bytes
     * @returns {{score:number, moved:boolean, warming:boolean, changed:number, bbox:?{x:number,y:number,w:number,h:number}}}
     */
    update(rgba) {
      toLuma(rgba, gray);
      boxBlur3(gray, tmp, blurred, width, height);

      if (seen < warmupFrames) {
        seen++;
        previous.set(blurred);
        return { score: 0, moved: false, warming: true, changed: 0, bbox: null };
      }

      let changed = 0;
      let minX = width;
      let minY = height;
      let maxX = -1;
      let maxY = -1;

      for (let y = 0, i = 0; y < height; y++) {
        for (let x = 0; x < width; x++, i++) {
          const delta = blurred[i] - previous[i];
          if ((delta < 0 ? -delta : delta) > pixelThreshold) {
            changed++;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }

      previous.set(blurred);

      const score = changed / size;
      return {
        score,
        moved: score >= areaThreshold,
        warming: false,
        changed,
        bbox: maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 },
      };
    },
  };
}

/** ITU-R BT.601 luma, integer approximation. */
function toLuma(rgba, out) {
  for (let p = 0, i = 0; i < rgba.length; i += 4, p++) {
    out[p] = (rgba[i] * 77 + rgba[i + 1] * 150 + rgba[i + 2] * 29) >> 8;
  }
}

/** Separable 3x3 box blur with edge clamping. */
function boxBlur3(src, tmp, dst, width, height) {
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const l = src[row + (x > 0 ? x - 1 : 0)];
      const c = src[row + x];
      const r = src[row + (x < width - 1 ? x + 1 : width - 1)];
      tmp[row + x] = (l + c + r) / 3;
    }
  }
  for (let y = 0; y < height; y++) {
    const up = (y > 0 ? y - 1 : 0) * width;
    const mid = y * width;
    const down = (y < height - 1 ? y + 1 : height - 1) * width;
    for (let x = 0; x < width; x++) {
      dst[mid + x] = (tmp[up + x] + tmp[mid + x] + tmp[down + x]) / 3;
    }
  }
}
