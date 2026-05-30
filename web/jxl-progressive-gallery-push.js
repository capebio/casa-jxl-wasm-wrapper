export function buildPushBatches(buffer, { mode = 'all-chunks', chunkSize = 65536, windowSize = 32 } = {}) {
  const normalizedMode = mode === 'full-file' || mode === 'window' ? mode : 'all-chunks';

  if (normalizedMode === 'full-file') {
    return [[buffer]];
  }

  const chunks = [];
  for (let offset = 0; offset < buffer.byteLength; offset += chunkSize) {
    const end = Math.min(offset + chunkSize, buffer.byteLength);
    chunks.push(buffer.slice(offset, end));
  }

  if (normalizedMode === 'all-chunks') {
    return chunks.map(chunk => [chunk]);
  }

  const batches = [];
  for (let offset = 0; offset < chunks.length; offset += windowSize) {
    batches.push(chunks.slice(offset, offset + windowSize));
  }
  return batches;
}
