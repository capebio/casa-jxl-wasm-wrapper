export function packFramePixels(frame) {
  const info = frame?.info ?? {};
  const width = Number(info.width ?? 0);
  const height = Number(info.height ?? 0);
  const bytesPerPixel = 4;
  const rowBytes = width * bytesPerPixel;

  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return new Uint8ClampedArray(0);
  }

  const source = toUint8Array(frame?.pixels);
  const stride = Number.isFinite(frame?.pixelStride) && frame.pixelStride > 0
    ? Math.floor(frame.pixelStride)
    : rowBytes;
  const packedLength = rowBytes * height;

  if (stride === rowBytes) {
    return source.byteOffset === 0 && source.byteLength === packedLength
      ? new Uint8ClampedArray(source.buffer, source.byteOffset, Math.min(source.byteLength, packedLength))
      : new Uint8ClampedArray(source.subarray(0, packedLength));
  }

  const packed = new Uint8ClampedArray(packedLength);
  for (let row = 0; row < height; row++) {
    const srcStart = row * stride;
    if (srcStart >= source.byteLength) break;
    const srcEnd = Math.min(srcStart + rowBytes, source.byteLength);
    packed.set(source.subarray(srcStart, srcEnd), row * rowBytes);
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
