/**
 * Build chunk batches for progressive push feeding.
 * Window/all-chunks modes yield between batches (Promise.all boundary) to allow
 * scheduler drain + progressive flushes (per DONOTCHANGE checkpoints).
 * @param {ArrayBuffer|Uint8Array} buffer
 * @param {{mode?: 'full-file'|'all-chunks'|'window', chunkSize?:number, windowSize?:number, byteCutoffs?:number[]}} opts
 */
export function buildPushBatches(buffer, { mode = 'all-chunks', chunkSize = 65536, windowSize = 32, byteCutoffs = null } = {}) {
  const normalizedMode = mode === 'full-file' || mode === 'window' ? mode : 'all-chunks';
  const u8 = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : (buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer));

  if (normalizedMode === 'full-file') {
    return [[u8.buffer]];
  }

  const n = u8.byteLength > 0 ? Math.ceil(u8.byteLength / chunkSize) : 0;
  const chunks = new Array(n);
  for (let i = 0, off = 0; i < n; i++, off += chunkSize) {
    const end = Math.min(off + chunkSize, u8.byteLength);
    chunks[i] = u8.subarray(off, end); // zero-copy view ("move the pointer")
  }

  if (normalizedMode === 'all-chunks') {
    return chunks.map(chunk => [chunk]);
  }

  const batches = [];
  for (let i = 0; i < chunks.length; i += windowSize) {
    batches.push(chunks.slice(i, i + windowSize));
  }
  return batches;
}
