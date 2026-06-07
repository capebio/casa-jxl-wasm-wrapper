import { writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import {
  GOBABEB_DIR,
  TIMING_OUT_DIR,
  decodeJxl,
  decodeRawToRgba,
  encodeJxl,
  ensureTimingOutDir,
  fmtMs,
  formatToon,
  initRawWasm,
  installBrowserLikeWorker,
  selectRawFiles,
  stampForFile,
} from "./optimal-settings-timing-utils.mjs";

installBrowserLikeWorker();
const { createDecoder, createEncoder, detectTier } = await import("../packages/jxl-wasm/dist/index.js");

// groupOrder 1 = center-out scan; progressiveDc controls how many DC layers are included.
// Together these determine how early a recognisable image appears during streaming.
// Sweep groupOrder × progressiveDc and capture first-frame arrival time.
const TARGET       = Number(process.env.TEST9_TARGET ?? "1600");
const QUALITY      = Number(process.env.TEST9_QUALITY ?? "85");
const EFFORT       = Number(process.env.TEST9_EFFORT ?? "3");
const LIMIT        = Math.max(1, Number(process.env.TEST9_LIMIT ?? "3"));
const GROUP_ORDERS = parseList(process.env.TEST9_GROUP_ORDERS ?? "0,1");
const PROG_DCS     = parseList(process.env.TEST9_PROG_DCS ?? "1,2");

function parseList(s) { return s.split(",").map(Number).filter(Number.isFinite); }

await initRawWasm();
ensureTimingOutDir();

const tier  = detectTier();
const files = selectRawFiles({
  primaryDir: process.env.TEST9_RAW_DIR ?? GOBABEB_DIR,
  extensions: [".orf"],
  limit: LIMIT,
  largest: true,
});
if (!files.length) throw new Error("test_9 needs at least one ORF file");

const records = [];
for (const file of files) {
  const decoded = decodeRawToRgba(file.path, TARGET);
  for (const groupOrder of GROUP_ORDERS) {
    for (const progressiveDc of PROG_DCS) {
      const encoded = await encodeJxl(createEncoder, decoded.rgba, decoded.width, decoded.height, {
        quality: QUALITY,
        effort: EFFORT,
        progressive: true,
        progressiveFlavor: "ac",
        previewFirst: false,
        chunked: true,
        groupOrder,
        progressiveDc,
      });
      const dec = await decodeJxl(createDecoder, encoded.bytes, {
        emitEveryPass: true,
        progressiveDetail: "passes",
        downsample: 1,
      });
      records.push({
        timestamp: new Date().toISOString(),
        file: basename(file.path),
        groupOrder,
        progressiveDc,
        encodeMs: encoded.ms,
        firstMs: dec.firstMs,
        finalMs: dec.ms,
        passes: dec.passes,
        size: encoded.bytes.byteLength,
      });
      console.log(`[test_9] ${basename(file.path)} grpOrd=${groupOrder} progDc=${progressiveDc} enc=${encoded.ms.toFixed(0)}ms first=${dec.firstMs.toFixed(0)}ms final=${dec.ms.toFixed(0)}ms passes=${dec.passes}`);
    }
  }
}

const stamp = stampForFile();
const toon  = formatToon({
  testName:  "GroupOrder + ProgressiveDc First-Frame (Test_9)",
  timestamp: new Date().toISOString(),
  tier,
  target:    TARGET,
  quality:   QUALITY,
  effort:    EFFORT,
  notes:     "groupOrder(0=raster,1=center-out) x progressiveDc(1,2); first-frame arrival time",
  columns:   ["t", "file", "grp_ord", "prog_dc", "encode_ms", "first_ms", "final_ms", "passes", "size"],
  records,
  row: (r, timeBase) => [
    r.timestamp.startsWith(timeBase) ? r.timestamp.slice(timeBase.length).replace(/Z$/, "") : r.timestamp,
    r.file,
    r.groupOrder,
    r.progressiveDc,
    fmtMs(r.encodeMs),
    fmtMs(r.firstMs),
    fmtMs(r.finalMs),
    r.passes,
    `${r.size}B`,
  ],
});
const outPath = join(TIMING_OUT_DIR, `${stamp}-test_9_group_order_progressive_dc.toon`);
writeFileSync(outPath, toon, "utf8");
console.log(`[test_9] wrote ${outPath}`);
process.exit(0);
