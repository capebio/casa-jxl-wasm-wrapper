// M8: LookRenderer render() texture/clarity path
// Old path: Vec::clone every call (~12.4 MB alloc for 1800×1200 RGB16)
// New path: thread-local scratch — allocates once, copy_from_slice each call
// Memory: run with `node --expose-gc` to see RSS delta between variants.

// Lightbox dims: 1800×1200, 3 u16 channels per pixel
const W = 1800;
const H = 1200;
const N = W * H * 3; // u16 element count = 6,480,000 → ~12.4 MB

// Simulate a realistic unsharp-mask pass (kernel convolution on luma channel).
// Reads all pixels, writes some — approximates the work in apply_unsharp_masks.
function simulateUnsharpMask(buf16, w, h) {
  // Simple 3×3 box luma sharpening on R channel (proxy for full kernel)
  const stride = w * 3;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = (y * w + x) * 3;
      const c = buf16[i];
      const n1 = buf16[i - stride];
      const n2 = buf16[i + stride];
      const n3 = buf16[i - 3];
      const n4 = buf16[i + 3];
      const laplacian = 4 * c - n1 - n2 - n3 - n4;
      buf16[i] = Math.max(0, Math.min(65535, c + (laplacian >> 3)));
    }
  }
}

function checksum(buf16) {
  let h = 0;
  for (let i = 0; i < buf16.length; i += 64) {
    h = (h * 31 + buf16[i]) >>> 0;
  }
  return h;
}

export const name = 'm8-render-scratch';
export const description =
  'LookRenderer texture path: Vec::clone (~12.4 MB/call) vs thread-local scratch (alloc-once, copy_from_slice). ' +
  'RSS delta shows per-call allocation pressure. Run with --expose-gc.';

export function setup({ width, height }) {
  const w = width ?? W;
  const h = height ?? H;
  const n = w * h * 3;
  const src = new Uint16Array(n);
  for (let i = 0; i < n; i++) {
    src[i] = ((i * 2654435761) >>> 16) & 0x3fff; // deterministic synthetic pixels
  }
  return { src, w, h };
}

export const variants = [
  {
    name: 'clone',
    baseline: true,
    note: 'old path: new Uint16Array(src) every call (Vec::clone equivalent)',
    run({ src, w, h }) {
      const scratch = new Uint16Array(src); // allocates + copies ~12.4 MB
      simulateUnsharpMask(scratch, w, h);
      return checksum(scratch);
    },
  },
  {
    name: 'thread-local-scratch',
    note: 'new path: module-level scratch reused (grows once, set() each call)',
    run: (() => {
      let scratch = null;
      return ({ src, w, h }) => {
        if (!scratch || scratch.length < src.length) {
          scratch = new Uint16Array(src.length); // alloc once
        }
        scratch.set(src); // copy_from_slice equivalent — no allocator call
        simulateUnsharpMask(scratch, w, h);
        return checksum(scratch);
      };
    })(),
  },
];

export function equal(a, b) {
  return a === b;
}
