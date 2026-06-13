export function packFramePixels(frame, options = {}) {
  const info = frame?.info ?? {};
  let width = Number(info.width ?? 0);
  let height = Number(info.height ?? 0);
  const bytesPerPixel = 4;
  const { roi, format = 'rgba8', forceCopy = false, constancyParams } = options;

  if (roi && Number.isFinite(roi.w) && roi.w > 0 && Number.isFinite(roi.h) && roi.h > 0) {
    width = roi.w;
    height = roi.h;
  }

  const rowBytes = width * bytesPerPixel;

  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return new Uint8ClampedArray(0);
  }

  const source = toUint8Array(frame?.pixels);
  const stride = Number.isFinite(frame?.pixelStride) && frame.pixelStride > 0
    ? Math.floor(frame.pixelStride)
    : rowBytes;
  const packedLength = rowBytes * height;

  // fast path: tight stride, no roi, allow view share (0-copy "pointer move")
  if (stride === rowBytes && !roi && !forceCopy && format === 'rgba8') {
    const viewLen = Math.min(source.byteLength, packedLength);
    if (source.byteOffset === 0 && source.byteLength >= packedLength) {
      return new Uint8ClampedArray(source.buffer, source.byteOffset, packedLength);
    }
    return new Uint8ClampedArray(source.subarray(0, viewLen));
  }

  const packed = new Uint8ClampedArray(packedLength);
  const y0 = (roi && Number.isFinite(roi.y)) ? roi.y : 0;
  const x0 = (roi && Number.isFinite(roi.x)) ? roi.x : 0;
  const srcRowSkip = x0 * bytesPerPixel;

  for (let row = 0; row < height; row++) {
    const srcStart = (y0 + row) * stride + srcRowSkip;
    if (srcStart >= source.byteLength) break;
    const srcEnd = Math.min(srcStart + rowBytes, source.byteLength);
    packed.set(source.subarray(srcStart, srcEnd), row * rowBytes);
  }

  // Hook for future Perceptual Constancy (Lens 17 non-Riemannian engine) / AR foveation.
  // Actual transform (log, matrix B, A_tensor, diminishing f(c), hybrid DE) lives in Rust LookRenderer.
  // When ready, apply in-place or return transformed view here (or no-op).
  if (constancyParams && constancyParams.mode === 'constancy') {
    // TODO: forward to WASM LUT or SIMD apply when exposed; for now pass-through packed
  }

  return packed;
}

function toUint8Array(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return new Uint8Array(0);
}
