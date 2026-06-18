# flipflop Tests

Standardized flip-flop timing tests for the flipflop skill. Tests are Node `.mjs` modules that define variants and corpus.

## Running Tests

```bash
node --expose-gc ../flipflop.mjs <test-name>.mjs [--options]
```

## Writing Tests

See `../flipflop.mjs --help` and the templates in `~/.claude/skills/flipflop/templates/`.

### Test File Contract

Required exports:
- `name`: string, test identifier
- `description`: string, one-line summary
- `variants`: array of `{ name, run | cmd, baseline?, role?, ... }`

Optional exports:
- `corpus()`: replaces fractal default with custom inputs (real files, etc.)
- `setup()`: pre-process each input before timing
- `equal(a, b)`: lossless guard (outputs match)
- `quality(out, baselineOut, ctx)`: perceptual scalar (Butteraugli, SSIM, etc.)

## Existing Tests

### selftest-double
Sanity fixture: 2×-work baseline → expect ~−100% saved_pct. Proves the harness measures real differences.

### tone-curve (scaffold)
**Status: Requires implementation**

Measures scalar `apply_tone_math` loop vs SIMD `apply_tone_bulk` on RGBA inputs. 

**To complete:**
1. Build `crates/raw-pipeline/examples/tone-bench.rs` (currently blocked on tone-matrix signatures — you need to wire the actual matrix construction).
2. Verify `apply_tone_math` and `tone_simd::apply_tone_bulk` signatures in your tone-curve code.
3. Update tone-bench.rs to call them correctly (the template shows the structure; adapt the call sites to match your tone-matrix API).
4. Then: `node --expose-gc ../flipflop.mjs tone-curve.mjs --sizes 512,1024 --print`

The template is in `../crates/raw-pipeline/examples/tone-bench.rs` and the test wrapper is in `tone-curve.mjs`.

## Notes

- Tests are gitignored by default. Force-add fixtures you want to keep: `git add -f tests/<name>.mjs`.
- Journal is local (not committed): `../docs/outputs/timing\ tests/flipflop/flipflopjournal.toon`.
- RGBA input is fractal corpus (deterministic) by default; override with `corpus()` hook for real files.
