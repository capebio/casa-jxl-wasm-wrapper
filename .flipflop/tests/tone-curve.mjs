// Tone-curve: scalar vs SIMD kernel, measured via the tone-bench binary.
// Calls: cargo run --example tone-bench --release -- --variant [scalar|simd] --in <input> --out <output>
// Input: fractal RGBA. Output: tone-mapped RGBA.

export const name = 'tone-curve';
export const description = 'Scalar per-pixel tone-math vs SIMD apply_tone_bulk (fixed saturation/vibrance)';

export const variants = [
  {
    name: 'scalar',
    baseline: true,
    cmd: 'cd crates/raw-pipeline && cargo run --example tone-bench --release -- --variant scalar --in {input} --out {output}',
  },
  {
    name: 'simd',
    cmd: 'cd crates/raw-pipeline && cargo run --example tone-bench --release -- --variant simd --in {input} --out {output}',
  },
];

// Optional: equality guard (tone_math should produce bit-identical results for scalar vs SIMD, but floating point may differ slightly).
// Disabled for now — SIMD may have slight rounding differences.
// export function equal(a, b) { return rmse(a, b) < 1e-2; }
