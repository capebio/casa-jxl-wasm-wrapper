export const PROGRESSIVE_WEB_BYTE_CUTOFFS = Object.freeze([
  1024,
  2 * 1024,
  5 * 1024,
  10 * 1024,
  25 * 1024,
  50 * 1024,
  100 * 1024,
  150 * 1024,
  250 * 1024,
  500 * 1024,
]);

export const DEFAULT_PROGRESSIVE_DC = 2;
export const DEFAULT_GROUP_ORDER = 1;
export const DEFAULT_PREVIEW_FIRST = true;
export const DEFAULT_EMIT_EVERY_PASS = true;
export const DEFAULT_PROGRESSIVE_DETAIL = 'passes';
export const DEFAULT_CHUNK_SIZE = 65536;
export const DEFAULT_WINDOW_SIZE = 32;

export function resolveTargetDimensions(width, height, targetLongEdge) {
  assertPositiveInteger(width, 'width');
  assertPositiveInteger(height, 'height');

  const sourceLongEdge = Math.max(width, height);
  const requested = targetLongEdge === 'full'
    ? sourceLongEdge
    : Math.max(1, Math.floor(Number(targetLongEdge)));
  const longEdge = Math.min(sourceLongEdge, requested);
  const scale = longEdge / sourceLongEdge;

  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    longEdge,
    scale,
  };
}

export function resolveQualityPolicy({ quality = 85, ssimulacra2Target = null } = {}) {
  const numericQuality = clamp(Math.round(Number(quality)), 1, 100);
  const requested = Number.isFinite(Number(ssimulacra2Target));
  return {
    mode: 'fixed-quality',
    quality: numericQuality,
    ssimulacra2: {
      requested,
      available: false,
      target: requested ? Number(ssimulacra2Target) : null,
      message: requested
        ? 'SSIMULACRA2 target search needs a real metric runner; using fixed quality until one is wired.'
        : 'SSIMULACRA2 target search not requested.',
    },
  };
}

export function createProgressiveWebPreset({
  width,
  height,
  targetLongEdge = 800,
  quality = 85,
  effort = 3,
  hasAlpha = true,
  ssimulacra2Target = null,
  progressiveDetail = DEFAULT_PROGRESSIVE_DETAIL,
  preserveIcc = false,
  preserveMetadata = false,
} = {}) {
  const target = resolveTargetDimensions(width, height, targetLongEdge);
  const qualityPolicy = resolveQualityPolicy({ quality, ssimulacra2Target });
  const encode = {
    format: 'rgba8',
    width: target.width,
    height: target.height,
    hasAlpha,
    quality: qualityPolicy.quality,
    effort: clamp(Math.round(Number(effort)), 1, 9),
    progressive: true,
    progressiveFlavor: 'ac',
    previewFirst: DEFAULT_PREVIEW_FIRST,
    progressiveDc: DEFAULT_PROGRESSIVE_DC,
    groupOrder: DEFAULT_GROUP_ORDER,
    chunked: false,
  };
  const decode = {
    format: 'rgba8',
    region: null,
    downsample: 1,
    progressionTarget: 'final',
    emitEveryPass: DEFAULT_EMIT_EVERY_PASS,
    progressiveDetail,
    preserveIcc,
    preserveMetadata,
  };
  return {
    name: 'progressive-web-preview',
    target,
    qualityPolicy,
    encode,
    decode,
    byteCutoffs: [...PROGRESSIVE_WEB_BYTE_CUTOFFS],
  };
}

export const SNEYERS_PRESET = Object.freeze({
  progressive: true,
  previewFirst: DEFAULT_PREVIEW_FIRST,
  progressiveDc: DEFAULT_PROGRESSIVE_DC,
  progressiveAc: 1,
  qProgressiveAc: 1,
  groupOrder: DEFAULT_GROUP_ORDER,
  effort: 3,
  decodingSpeed: 0,
});

export function createSneyersPreset({
  width,
  height,
  targetLongEdge = 1200,
  quality = 85,
  hasAlpha = true,
  progressiveDetail = DEFAULT_PROGRESSIVE_DETAIL,
  ssimulacra2Target = null,
  preserveIcc = false,
  preserveMetadata = false,
} = {}) {
  const target = resolveTargetDimensions(width, height, targetLongEdge);
  const qualityPolicy = resolveQualityPolicy({ quality, ssimulacra2Target });
  const encode = {
    format: 'rgba8',
    width: target.width,
    height: target.height,
    hasAlpha,
    quality: qualityPolicy.quality,
    chunked: false,
    ...SNEYERS_PRESET,
  };
  const decode = {
    format: 'rgba8',
    region: null,
    downsample: 1,
    progressionTarget: 'final',
    emitEveryPass: DEFAULT_EMIT_EVERY_PASS,
    progressiveDetail,
    preserveIcc,
    preserveMetadata,
  };
  return {
    name: 'sneyers',
    target,
    qualityPolicy,
    encode,
    decode,
    byteCutoffs: [...PROGRESSIVE_WEB_BYTE_CUTOFFS],
  };
}

export function createSidecarTargetPlan(targetLongEdge, { thumbnailLongEdge = 300 } = {}) {
  const target = targetLongEdge === 'full' ? 'full' : Math.max(1, Math.floor(Number(targetLongEdge)));
  const thumb = Math.max(1, Math.floor(Number(thumbnailLongEdge)));
  if (target !== 'full' && target <= thumb) return [target];
  return [thumb, target];
}

export function getPushBatchingOptions(fileByteLength, { chunkSize = DEFAULT_CHUNK_SIZE, windowSize = DEFAULT_WINDOW_SIZE, byteCutoffs = PROGRESSIVE_WEB_BYTE_CUTOFFS } = {}) {
  const size = Number(fileByteLength) || 0;
  let w = windowSize;
  if (size > (byteCutoffs[9] || 500 * 1024)) w = Math.min(16, windowSize);
  else if (size > (byteCutoffs[7] || 150 * 1024)) w = Math.min(24, windowSize);
  return { mode: 'window', chunkSize, windowSize: w };
}

function assertPositiveInteger(value, name) {
  if (!Number.isFinite(Number(value)) || Number(value) <= 0) {
    throw new RangeError(`${name} must be a positive finite number`);
  }
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}
