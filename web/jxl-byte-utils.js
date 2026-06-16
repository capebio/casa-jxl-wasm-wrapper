// Canonical byte and transport utilities for JXL streaming and benchmarking.

export const TRANSPORT_PROFILES = Object.freeze({
  '3g': Object.freeze({ name: '3g', chunkBytes: 8 * 1024, chunkDelayMs: 220, jitterMs: 60 }),
  lte: Object.freeze({ name: 'lte', chunkBytes: 16 * 1024, chunkDelayMs: 80, jitterMs: 20 }),
  wifi: Object.freeze({ name: 'wifi', chunkBytes: 64 * 1024, chunkDelayMs: 20, jitterMs: 5 }),
  'diagnostic-passes': Object.freeze({ name: 'diagnostic-passes', chunkBytes: 4 * 1024, chunkDelayMs: 0, jitterMs: 0 }),
});

export function resolveTransportProfile(profile) {
  if (typeof profile === 'string') {
    return TRANSPORT_PROFILES[profile] ?? TRANSPORT_PROFILES.lte;
  }
  if (profile && Number.isFinite(Number(profile.chunkBytes))) {
    return {
      name: profile.name ?? 'custom',
      chunkBytes: Math.max(1024, Math.floor(Number(profile.chunkBytes))),
      chunkDelayMs: Math.max(0, Number(profile.chunkDelayMs) || 0),
      jitterMs: Math.max(0, Number(profile.jitterMs) || 0),
    };
  }
  return TRANSPORT_PROFILES.lte;
}

export function exactBuffer(view) {
  if (view instanceof ArrayBuffer) return view;
  return view.byteOffset === 0 && view.byteLength === view.buffer.byteLength
    ? view.buffer
    : view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
}

export function toUint8Array(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError('frame pixels must be ArrayBuffer or ArrayBufferView');
}

export function createChunkFeeder(jxlBytes, chunkBytes) {
  // Pure discrete partition of the byte range [0, length) into fixed-size quanta (last may be smaller).
  // Returns owned small ArrayBuffers so callers can advance a cursor without re-deriving slices
  // from the master on every step. Useful for flip-flop timing experiments and external harnesses.
  const jb = exactBuffer(jxlBytes);
  const chunks = [];
  for (let o = 0; o < jb.byteLength; o += chunkBytes) {
    const e = Math.min(o + chunkBytes, jb.byteLength);
    chunks.push(jb.slice(o, e));
  }
  return { chunks, totalBytes: jb.byteLength };
}

export class ByteIntervalCursor {
  // Tiny mathematical abstraction over the byte interval [0, total) partitioned into fixed-size quanta.
  // Encapsulates the partition (via createChunkFeeder) and the advancing cursor (cIdx, cOff).
  // The hot loop only asks "cover the next 'need' bytes" and gets back the exact buffer to push + how far we advanced.
  // This makes the discrete covering math, remainder handling, and pre-paid copy explicit and reusable
  // (e.g. for different partitioning strategies or flip-flop experiments).
  constructor(jxlBytes, chunkBytes) {
    const { chunks } = createChunkFeeder(jxlBytes, chunkBytes);
    this.chunks = chunks;
    this.cIdx = 0;
    this.cOff = 0;
    this.offset = 0;
  }

  get currentOffset() { return this.offset; }
  reset() { this.cIdx = 0; this.cOff = 0; this.offset = 0; }

  // Returns { buffer: ArrayBuffer to push, advanced: bytes covered } or {buffer: null, advanced: 0} when exhausted.
  // For full quanta we return the pre-owned AB (no copy). For partial tails only the needed sub-slice is copied.
  nextFor(need) {
    if (this.cIdx >= this.chunks.length || need <= 0) {
      return { buffer: null, advanced: 0 };
    }
    const pre = this.chunks[this.cIdx];
    const remain = pre.byteLength - this.cOff;
    const take = Math.min(need, remain);
    if (take <= 0) return { buffer: null, advanced: 0 };

    let buf;
    if (this.cOff === 0 && take === pre.byteLength) {
      buf = pre; // identity hand-off of owned AB
    } else {
      buf = pre.slice(this.cOff, this.cOff + take);
    }
    this.cOff += take;
    this.offset += take;
    if (this.cOff >= pre.byteLength) {
      this.cIdx++;
      this.cOff = 0;
    }
    return { buffer: buf, advanced: take };
  }
}

export class LazyByteIntervalCursor {
  // Lazy variant: slices on demand instead of pre-partitioning the whole buffer.
  // Same nextFor() contract as ByteIntervalCursor. Saves peak memory for single-run
  // benchmarks (no upfront chunk array). Use eager ByteIntervalCursor when the same
  // stream is walked multiple times (runCount > 1) so the partition amortizes.
  constructor(jxlBytes, chunkBytes) {
    this.buf = exactBuffer(jxlBytes);
    this.chunkBytes = chunkBytes;
    this.offset = 0;
  }

  get currentOffset() { return this.offset; }
  reset() { this.offset = 0; }

  nextFor(need) {
    if (this.offset >= this.buf.byteLength || need <= 0) return { buffer: null, advanced: 0 };
    const chunkStart = this.offset;
    const chunkEnd = Math.min(chunkStart + this.chunkBytes, this.buf.byteLength);
    const take = Math.min(need, chunkEnd - chunkStart);
    if (take <= 0) return { buffer: null, advanced: 0 };
    const buffer = this.buf.slice(chunkStart, chunkStart + take);
    this.offset += take;
    return { buffer, advanced: take };
  }
}
