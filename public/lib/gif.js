/**
 * Dependency-free animated GIF89a encoder.
 *
 * Isomorphic: no DOM and no Node built-ins are used, so the exact same module
 * runs in the browser, in a Web Worker and under `node --input-type=module`.
 * That is what lets `scripts/selftest.mjs` verify the encoder outside a browser.
 *
 * Pipeline: RGBA frames -> 5-bit colour histogram -> median-cut palette
 * (<=256 colours, shared by every frame) -> per-pixel index lookup -> LZW ->
 * GIF blocks.
 *
 * Format reference: GIF89a specification, https://www.w3.org/Graphics/GIF/spec-gif89a.txt
 */

const HIST_BITS = 5; // 5 bits per channel => 32768 histogram buckets
const HIST_SIZE = 1 << (HIST_BITS * 3);

/**
 * @param {Array<Uint8ClampedArray|Uint8Array>} frames RGBA pixel buffers, all width*height*4 bytes.
 * @param {object} opts
 * @param {number} opts.width
 * @param {number} opts.height
 * @param {number} [opts.delay=100] frame delay in milliseconds (rounded to 10ms GIF ticks)
 * @param {number} [opts.loop=0] 0 = loop forever
 * @param {number} [opts.maxColors=256]
 * @returns {Uint8Array} complete GIF file bytes
 */
export function encodeGif(frames, opts) {
  const { width, height } = opts;
  if (!Array.isArray(frames) || frames.length === 0) throw new Error('encodeGif: no frames');
  if (!width || !height) throw new Error('encodeGif: width/height required');

  const expected = width * height * 4;
  for (const f of frames) {
    if (f.length !== expected) {
      throw new Error(`encodeGif: frame size ${f.length} != ${expected} (${width}x${height})`);
    }
  }

  const delay = Math.max(2, Math.round((opts.delay ?? 100) / 10)); // GIF ticks = 10ms
  const loop = opts.loop ?? 0;
  const maxColors = Math.min(256, Math.max(2, opts.maxColors ?? 256));

  const { palette, lut } = buildPalette(frames, maxColors);
  const paletteSize = palette.length / 3;

  // Size of the colour table must be a power of two, minimum 2.
  let tableBits = 1;
  while (1 << tableBits < paletteSize) tableBits++;
  const tableSize = 1 << tableBits;

  const out = new ByteBuffer(width * height * frames.length * 0.5 + 1024);

  // --- Header ---
  out.writeAscii('GIF89a');

  // --- Logical Screen Descriptor ---
  out.writeU16(width);
  out.writeU16(height);
  out.writeByte(0x80 | ((tableBits - 1) << 4) | (tableBits - 1)); // GCT present, colour resolution, GCT size
  out.writeByte(0); // background colour index
  out.writeByte(0); // pixel aspect ratio

  // --- Global Colour Table ---
  for (let i = 0; i < tableSize; i++) {
    if (i < paletteSize) {
      out.writeByte(palette[i * 3]);
      out.writeByte(palette[i * 3 + 1]);
      out.writeByte(palette[i * 3 + 2]);
    } else {
      out.writeByte(0);
      out.writeByte(0);
      out.writeByte(0);
    }
  }

  // --- NETSCAPE2.0 looping extension ---
  if (frames.length > 1) {
    out.writeByte(0x21);
    out.writeByte(0xff);
    out.writeByte(11);
    out.writeAscii('NETSCAPE2.0');
    out.writeByte(3);
    out.writeByte(1);
    out.writeU16(loop);
    out.writeByte(0);
  }

  const minCodeSize = Math.max(2, tableBits);
  const indices = new Uint8Array(width * height);

  for (const frame of frames) {
    quantizeFrame(frame, lut, palette, indices);

    // --- Graphic Control Extension ---
    out.writeByte(0x21);
    out.writeByte(0xf9);
    out.writeByte(4);
    out.writeByte(0x04); // disposal method 1 (do not dispose), no transparency
    out.writeU16(delay);
    out.writeByte(0); // transparent colour index (unused)
    out.writeByte(0);

    // --- Image Descriptor ---
    out.writeByte(0x2c);
    out.writeU16(0);
    out.writeU16(0);
    out.writeU16(width);
    out.writeU16(height);
    out.writeByte(0); // no local colour table, not interlaced

    out.writeByte(minCodeSize);
    lzwEncode(minCodeSize, indices, out);
  }

  out.writeByte(0x3b); // trailer
  return out.toUint8Array();
}

/** Growable byte sink. */
class ByteBuffer {
  constructor(capacity = 1024) {
    this.buf = new Uint8Array(Math.max(1024, Math.ceil(capacity)));
    this.len = 0;
  }
  ensure(n) {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }
  writeByte(b) {
    this.ensure(1);
    this.buf[this.len++] = b & 0xff;
  }
  writeU16(v) {
    this.ensure(2);
    this.buf[this.len++] = v & 0xff;
    this.buf[this.len++] = (v >> 8) & 0xff;
  }
  writeAscii(s) {
    this.ensure(s.length);
    for (let i = 0; i < s.length; i++) this.buf[this.len++] = s.charCodeAt(i) & 0xff;
  }
  toUint8Array() {
    return this.buf.slice(0, this.len);
  }
}

/**
 * Median-cut palette shared by all frames, plus a lazy 32768-entry lookup table
 * mapping a 5-bit RGB bucket to its palette index.
 */
function buildPalette(frames, maxColors) {
  const counts = new Float64Array(HIST_SIZE);
  const sumR = new Float64Array(HIST_SIZE);
  const sumG = new Float64Array(HIST_SIZE);
  const sumB = new Float64Array(HIST_SIZE);

  // Sample at most ~400k pixels overall; surveillance frames are highly redundant.
  const totalPixels = frames.reduce((acc, f) => acc + f.length / 4, 0);
  const step = Math.max(1, Math.floor(totalPixels / 400000));

  for (const frame of frames) {
    for (let p = 0, i = 0; i < frame.length; i += 4, p++) {
      if (p % step !== 0) continue;
      const r = frame[i];
      const g = frame[i + 1];
      const b = frame[i + 2];
      const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      counts[key]++;
      sumR[key] += r;
      sumG[key] += g;
      sumB[key] += b;
    }
  }

  const used = [];
  for (let k = 0; k < HIST_SIZE; k++) if (counts[k] > 0) used.push(k);

  if (used.length === 0) {
    return { palette: new Uint8Array([0, 0, 0]), lut: new Int16Array(HIST_SIZE) };
  }

  let boxes = [makeBox(used, counts)];

  while (boxes.length < maxColors) {
    // Split the box with the most pixels that still has more than one bucket.
    let target = -1;
    let best = -1;
    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i];
      if (box.keys.length < 2) continue;
      const score = box.count * (1 + box.volume);
      if (score > best) {
        best = score;
        target = i;
      }
    }
    if (target < 0) break;

    const box = boxes[target];
    const shift = box.longestAxis === 0 ? 10 : box.longestAxis === 1 ? 5 : 0;
    box.keys.sort((a, b) => ((a >> shift) & 31) - ((b >> shift) & 31));

    // Walk to the weighted median, then clamp so that both halves keep at least
    // one bucket. Without the clamp a box whose weight sits almost entirely in
    // its last bucket — a dark room where the background dominates — produces
    // an empty right half, and every other colour in that box is lost.
    const half = box.count / 2;
    let acc = 0;
    let cut = 0;
    for (; cut < box.keys.length - 1; cut++) {
      acc += counts[box.keys[cut]];
      if (acc >= half) break;
    }
    if (cut > box.keys.length - 2) cut = box.keys.length - 2;

    const left = box.keys.slice(0, cut + 1);
    const right = box.keys.slice(cut + 1);
    boxes.splice(target, 1, makeBox(left, counts), makeBox(right, counts));
  }

  const palette = new Uint8Array(boxes.length * 3);
  boxes.forEach((box, i) => {
    let r = 0;
    let g = 0;
    let b = 0;
    for (const key of box.keys) {
      r += sumR[key];
      g += sumG[key];
      b += sumB[key];
    }
    palette[i * 3] = clamp255(Math.round(r / box.count));
    palette[i * 3 + 1] = clamp255(Math.round(g / box.count));
    palette[i * 3 + 2] = clamp255(Math.round(b / box.count));
  });

  const lut = new Int16Array(HIST_SIZE).fill(-1);
  return { palette, lut };
}

function makeBox(keys, counts) {
  let count = 0;
  let rmin = 31;
  let rmax = 0;
  let gmin = 31;
  let gmax = 0;
  let bmin = 31;
  let bmax = 0;
  for (const key of keys) {
    count += counts[key];
    const r = (key >> 10) & 31;
    const g = (key >> 5) & 31;
    const b = key & 31;
    if (r < rmin) rmin = r;
    if (r > rmax) rmax = r;
    if (g < gmin) gmin = g;
    if (g > gmax) gmax = g;
    if (b < bmin) bmin = b;
    if (b > bmax) bmax = b;
  }
  const dr = rmax - rmin;
  const dg = gmax - gmin;
  const db = bmax - bmin;
  const longestAxis = dr >= dg && dr >= db ? 0 : dg >= db ? 1 : 2;
  return { keys, count, volume: (dr + 1) * (dg + 1) * (db + 1), longestAxis };
}

/** Map one RGBA frame onto palette indices, filling the lookup table lazily. */
function quantizeFrame(frame, lut, palette, out) {
  for (let p = 0, i = 0; i < frame.length; i += 4, p++) {
    const key = ((frame[i] >> 3) << 10) | ((frame[i + 1] >> 3) << 5) | (frame[i + 2] >> 3);
    let idx = lut[key];
    if (idx < 0) {
      idx = nearestColor(key, palette);
      lut[key] = idx;
    }
    out[p] = idx;
  }
}

function nearestColor(key, palette) {
  // Bucket centre in full 8-bit space.
  const r = (((key >> 10) & 31) << 3) | 4;
  const g = (((key >> 5) & 31) << 3) | 4;
  const b = ((key & 31) << 3) | 4;
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < palette.length; i += 3) {
    const dr = r - palette[i];
    const dg = g - palette[i + 1];
    const db = b - palette[i + 2];
    const dist = dr * dr + dg * dg + db * db;
    if (dist < bestDist) {
      bestDist = dist;
      best = i / 3;
      if (dist === 0) break;
    }
  }
  return best;
}

/**
 * GIF-flavoured LZW: variable code width, LSB-first bit packing, output split
 * into sub-blocks of at most 255 bytes and terminated by a zero-length block.
 */
function lzwEncode(minCodeSize, indices, out) {
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;

  let codeSize = minCodeSize + 1;
  let nextCode = eoiCode + 1;
  let table = new Map();

  let bitBuffer = 0;
  let bitCount = 0;
  const block = new Uint8Array(255);
  let blockLen = 0;

  const flushBlock = () => {
    if (blockLen === 0) return;
    out.writeByte(blockLen);
    for (let i = 0; i < blockLen; i++) out.writeByte(block[i]);
    blockLen = 0;
  };

  const emit = (code) => {
    bitBuffer |= code << bitCount;
    bitCount += codeSize;
    while (bitCount >= 8) {
      block[blockLen++] = bitBuffer & 0xff;
      bitBuffer >>= 8;
      bitCount -= 8;
      if (blockLen === 255) flushBlock();
    }
  };

  emit(clearCode);

  let current = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const key = (current << 8) | k;
    const found = table.get(key);
    if (found !== undefined) {
      current = found;
      continue;
    }
    emit(current);
    if (nextCode === 4096) {
      emit(clearCode);
      table = new Map();
      nextCode = eoiCode + 1;
      codeSize = minCodeSize + 1;
    } else {
      if (nextCode >= 1 << codeSize) codeSize++;
      table.set(key, nextCode++);
    }
    current = k;
  }

  emit(current);
  emit(eoiCode);

  // Flush remaining bits at the final (possibly grown) code size.
  if (bitCount > 0) {
    block[blockLen++] = bitBuffer & 0xff;
    if (blockLen === 255) flushBlock();
  }
  flushBlock();
  out.writeByte(0); // block terminator
}

function clamp255(v) {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}
