// benchmark/generate-perceptual-manifest.mjs
//
// Generate a perceptual + scale-aware progressive manifest sidecar (<file>.jxl.json) for a .jxl.
//
// STATUS: production usage example. NOT executed in CI — the pure pipeline (profiler →
// scoring → scale frontier → validate) is covered runnably by
// packages/jxl-progressive/test/profile-integration.test.ts. This script wires the REAL
// wasm-backed scorer/downscaler and a live decode session, so it requires:
//   - metric=butteraugli → a wasm build with the butteraugli bridge (computeButteraugli)
//   - the scale frontier   → the raw-pipeline wasm (downscale_rgba, web/pkg)
// SSIM/PSNR metrics are pure-JS and need no wasm.
//
// Usage: node benchmark/generate-perceptual-manifest.mjs <file.jxl> <width> <height> [psnr|ssim|butteraugli]
import {
  profileJxlFile, makeButteraugliScorer, makeWasmDownscaler, psnrVsRef, ssimVsRef,
} from "../packages/jxl-progressive/dist/index.js";
import { createBrowserContext } from "../packages/jxl-session/dist/index.js";

const [path, wArg, hArg, metric = "psnr"] = process.argv.slice(2);
if (!path || !wArg || !hArg) {
  console.error("usage: node benchmark/generate-perceptual-manifest.mjs <file.jxl> <width> <height> [metric]");
  process.exit(1);
}
const width = Number(wArg), height = Number(hArg);

const ctx = createBrowserContext();
const sessionFactory = () =>
  ctx.createDecodeSession({ format: "rgba8", emitEveryPass: true, progressionTarget: "final", progressiveDetail: "passes" });

// Metric scorer: SSIM/PSNR pure-JS; butteraugli via the wasm bridge (lazy/premium metric).
let scorer;
if (metric === "butteraugli") {
  const { computeButteraugli } = await import("@casabio/jxl-wasm");
  scorer = makeButteraugliScorer((a, b, w, h) => computeButteraugli(a, b, w, h));
} else {
  scorer = { metric, score: async (c, r, w, h) => (metric === "ssim" ? ssimVsRef(c, r, w, h) : psnrVsRef(c, r)) };
}

// Scale-frontier downscaler: production uses the raw-pipeline wasm downscale_rgba.
const { default: initRaw, downscale_rgba } = await import("../web/pkg/raw_pipeline.js");
await initRaw();
const downscaler = makeWasmDownscaler(downscale_rgba);

const manifest = await profileJxlFile(
  path, sessionFactory, { width, height, hasAlpha: false },
  { scorer, downscaler, displaySizes: [256, 512, 1024, 2048], encoderName: "casabio", writeManifest: true },
);
console.log(JSON.stringify(manifest, null, 2));
