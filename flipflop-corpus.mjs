// flipflop-corpus.mjs — deterministic fractal corpus + input resolution (zero deps)
import { createHash } from 'node:crypto';
import { writeFileSync, readFileSync, statSync, existsSync, mkdirSync, globSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';

export const FRACTAL_KEYS = ['mandel', 'fbm', 'branch'];

function renderMandelbrot(w, h, maxIter = 96) {
  const buf = new Uint8Array(w * h * 4);
  const xMin = -2.5, xMax = 1.0, yMin = -1.0, yMax = 1.0;
  for (let py = 0; py < h; py++) {
    const y = yMin + (py / (h - 1 || 1)) * (yMax - yMin);
    for (let px = 0; px < w; px++) {
      const x = xMin + (px / (w - 1 || 1)) * (xMax - xMin);
      let zx = 0, zy = 0, i = 0;
      while (zx * zx + zy * zy < 4 && i < maxIter) {
        const xt = zx * zx - zy * zy + x;
        zy = 2 * zx * zy + y; zx = xt; i++;
      }
      const v = Math.floor(255 * (i / maxIter));
      const j = (py * w + px) * 4;
      buf[j] = v; buf[j + 1] = (v * 0.65) | 0; buf[j + 2] = (v * 1.15) & 0xff; buf[j + 3] = 255;
    }
  }
  return buf;
}

function renderFbmNoise(w, h, octaves = 6) {
  const buf = new Uint8Array(w * h * 4);
  const n = w * h, baseFreq = 3.0;
  for (let i = 0; i < n; i++) {
    const px = i % w, py = (i / w) | 0;
    const u = (px + 0.5) / w, v = (py + 0.5) / h;
    let val = 0, amp = 1, freq = baseFreq, x = 0x9e37 | 1;
    for (let o = 0; o < octaves; o++) {
      const nx = u * freq, ny = v * freq;
      let hsh = (Math.floor(nx * 374761393) ^ Math.floor(ny * 668265263) ^ x) >>> 0;
      hsh = (hsh ^ (hsh >>> 13)) * 1274126177;
      val += amp * ((hsh / 0xffffffff) - 0.5);
      amp *= 0.5; freq *= 2; x = ((x * 1812433253 + 12345) & 0xffffffff) >>> 0;
    }
    const g = Math.max(0, Math.min(255, 128 + (val * 90) | 0));
    const j = i * 4; buf[j] = g; buf[j + 1] = g; buf[j + 2] = (g * 1.08) & 0xff; buf[j + 3] = 255;
  }
  return buf;
}

function renderBranching(w, h, iters = 7) {
  const buf = new Uint8Array(w * h * 4);
  const n = w * h;
  for (let i = 0; i < n; i++) {
    const px = i % w, py = (i / w) | 0;
    let u = (px + 0.5) / w - 0.5, v = (py + 0.5) / h - 0.5;
    let r = Math.hypot(u, v), ang = Math.atan2(v, u), val = 0, amp = 1, x = 0xabc123 | 1;
    for (let k = 0; k < iters; k++) {
      x ^= x << 13; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
      const p = ((x & 0x7fff) / 0x7fff - 0.5) * 0.6;
      val += amp * Math.sin(ang * (2 + k) + p) * (1 - r * 0.8);
      amp *= 0.65; ang *= 1.3; r = Math.max(0.01, r * 0.9);
    }
    const g = Math.max(0, Math.min(255, 128 + (val * 110) | 0));
    const j = i * 4; buf[j] = (g * 0.85) | 0; buf[j + 1] = g; buf[j + 2] = (g * 1.25) & 0xff; buf[j + 3] = 255;
  }
  return buf;
}

const RENDER = { mandel: renderMandelbrot, fbm: renderFbmNoise, branch: renderBranching };

export function renderFractal(type, size) {
  const fn = RENDER[type];
  if (!fn) throw new Error(`unknown fractal type: ${type}`);
  return { rgba: fn(size, size), width: size, height: size };
}

export function sha1Hex(u8) {
  return createHash('sha1').update(Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength)).digest('hex');
}

// Minimal baseline TIFF: little-endian, 8-bit RGB, single uncompressed strip.
export function writeTiffRgb(path, rgba, w, h) {
  const px = w * h;
  const data = Buffer.alloc(px * 3);
  for (let i = 0, j = 0; i < px; i++) { data[j++] = rgba[i * 4]; data[j++] = rgba[i * 4 + 1]; data[j++] = rgba[i * 4 + 2]; }
  const numTags = 10;
  const ifdOffset = 8;
  const ifdLen = 2 + numTags * 12 + 4;       // count + entries + nextIFD
  const bpsOffset = ifdOffset + ifdLen;      // 3 shorts for BitsPerSample
  const dataOffset = bpsOffset + 6;
  const buf = Buffer.alloc(dataOffset + data.length);
  buf.write('II', 0, 'ascii'); buf.writeUInt16LE(42, 2); buf.writeUInt32LE(ifdOffset, 4);
  let o = ifdOffset;
  buf.writeUInt16LE(numTags, o); o += 2;
  const tag = (id, type, count, value) => {
    buf.writeUInt16LE(id, o); buf.writeUInt16LE(type, o + 2);
    buf.writeUInt32LE(count, o + 4); buf.writeUInt32LE(value, o + 8); o += 12;
  };
  // TIFF types: 3 = SHORT, 4 = LONG. Tags MUST be ascending by id.
  tag(256, 4, 1, w);             // ImageWidth
  tag(257, 4, 1, h);             // ImageLength
  tag(258, 3, 3, bpsOffset);     // BitsPerSample -> 3 shorts at bpsOffset
  tag(259, 3, 1, 1);             // Compression = none
  tag(262, 3, 1, 2);             // PhotometricInterpretation = RGB
  tag(273, 4, 1, dataOffset);    // StripOffsets
  tag(277, 3, 1, 3);             // SamplesPerPixel
  tag(278, 4, 1, h);             // RowsPerStrip (single strip)
  tag(279, 4, 1, data.length);   // StripByteCounts
  tag(284, 3, 1, 1);             // PlanarConfiguration = chunky
  buf.writeUInt32LE(0, o);       // next IFD = 0
  buf.writeUInt16LE(8, bpsOffset); buf.writeUInt16LE(8, bpsOffset + 2); buf.writeUInt16LE(8, bpsOffset + 4);
  data.copy(buf, dataOffset);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, buf);
}

function normalizeItem(it) {
  return { name: it.name, kind: it.kind || (it.path ? 'file' : 'fractal'),
    type: it.type, size: it.size, width: it.width, height: it.height,
    rgba: it.rgba, bytes: it.bytes, path: it.path, rounds: it.rounds };
}

export async function resolveInputs({ test, inputsGlob, types = FRACTAL_KEYS, sizes = [256, 512, 1024, 2048, 4096] }) {
  if (test && typeof test.corpus === 'function') {
    const items = await test.corpus({});
    return items.map(normalizeItem);
  }
  if (inputsGlob) {
    const files = globSync(inputsGlob).filter((f) => statSync(f).isFile());
    return files.map((f) => normalizeItem({ name: basename(f), kind: 'file', path: f, size: statSync(f).size }));
  }
  const out = [];
  for (const ty of types) for (const sz of sizes) {
    out.push(normalizeItem({ name: `${ty}@${sz}`, kind: 'fractal', type: ty, size: sz, width: sz, height: sz }));
  }
  return out;
}

// Populate heavy payload on demand; engine frees between items.
export function loadItem(item) {
  if (item.kind === 'fractal') {
    const { rgba, width, height } = renderFractal(item.type, item.size);
    return { ...item, rgba, width, height };
  }
  if (item.kind === 'file' && item.path && !item.bytes) {
    return { ...item, bytes: new Uint8Array(readFileSync(item.path)) };
  }
  return item;
}

export function corpusCacheDir() {
  const d = join(tmpdir(), 'flipflop-corpus');
  mkdirSync(d, { recursive: true });
  return d;
}

// For cmd-mode: return a real file path for {input}. Files use their own path; fractals get a cached TIFF.
export function materializeTiff(loaded) {
  if (loaded.kind === 'file') return loaded.path;
  const p = join(corpusCacheDir(), `${loaded.type}_${loaded.size}.tiff`);
  if (!existsSync(p)) writeTiffRgb(p, loaded.rgba, loaded.width, loaded.height);
  return p;
}
