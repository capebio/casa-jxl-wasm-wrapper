// Phase A — Gobabeb ingest simulation (the "server side", done ONCE).
//
// For each ORF: decode RAW→RGBA, encode a full-size JXL (the stored master), then GENERATE
// THUMBNAILS (256 + 1024 long-edge JXLs) in the same pass. Times each stage; the thumbnail
// block is timed start→stop (the cost the pyramid adds to ingest). Writes all artifacts to a
// work dir = the simulated server store, plus a manifest.json consumed by Phase B.
//
//   node tools/gob-pyramid-ingest.mjs            # default 24 files
//   GOB_LIMIT=30 node tools/gob-pyramid-ingest.mjs
//   GOB_DIR="C:\path" GOB_LIMIT=12 node tools/gob-pyramid-ingest.mjs

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join, basename, extname } from "node:path";
import { tmpdir } from "node:os";
import { decodeFileToRgba } from "../.flipflop/lib/raw-corpus.mjs";
import { installJxlScalar, resizeRgba8ToLongEdge, LADDER } from "../.flipflop/lib/jxl-node.mjs";
import { encodeTileContainerRgba8 } from "../packages/jxl-wasm/dist/facade.js";

const GOB_DIR = process.env.GOB_DIR ?? String.raw`C:\995\2026-02-20 Gobabeb To Windhoek`;
const LIMIT = Number(process.env.GOB_LIMIT || 24);
const THUMB = 256;
const PREVIEW = 1024;
const WORK = join(tmpdir(), "gob-pyramid-sim");

installJxlScalar();

function encodeLevel(rgba, w, h, distance) {
  return encodeTileContainerRgba8(rgba, w, h, { tileSize: LADDER.tileSize, distance, effort: LADDER.effort });
}

async function main() {
  mkdirSync(WORK, { recursive: true });
  const files = readdirSync(GOB_DIR)
    .filter((f) => extname(f).toLowerCase() === ".orf")
    .sort()
    .slice(0, LIMIT)
    .map((f) => join(GOB_DIR, f));

  if (files.length === 0) throw new Error(`no ORF files in ${GOB_DIR}`);
  console.log(`Ingesting ${files.length} ORF files from ${GOB_DIR}\n  → store: ${WORK}\n`);

  const agg = { rawDecodeMs: 0, fullEncMs: 0, thumbGenMs: 0, srcBytes: 0, fullBytes: 0, t256Bytes: 0, t1024Bytes: 0 };
  const manifest = [];
  const wallStart = performance.now();

  for (let i = 0; i < files.length; i++) {
    const path = files[i];
    const name = basename(path);
    const stem = String(i).padStart(3, "0");

    // RAW decode (the per-file master cost — paid regardless of pyramid).
    const tDec0 = performance.now();
    const { rgba, width, height } = decodeFileToRgba(path);
    const rawDecodeMs = performance.now() - tDec0;

    // Full master JXL (the stored full-res asset).
    const tFull0 = performance.now();
    const fullJxl = await encodeLevel(rgba, width, height, LADDER.fullDistance);
    const fullEncMs = performance.now() - tFull0;

    // ── THUMBNAIL GENERATION START ──────────────────────────────────────────
    const tThumb0 = performance.now();
    const r256 = resizeRgba8ToLongEdge(rgba, width, height, THUMB);
    const j256 = await encodeLevel(r256.data, r256.width, r256.height, LADDER.gridDistance);
    const r1024 = resizeRgba8ToLongEdge(rgba, width, height, PREVIEW);
    const j1024 = await encodeLevel(r1024.data, r1024.width, r1024.height, LADDER.gridDistance);
    const thumbGenMs = performance.now() - tThumb0;
    // ── THUMBNAIL GENERATION STOP ───────────────────────────────────────────

    const pFull = join(WORK, `${stem}.full.jxl`);
    const p256 = join(WORK, `${stem}.t256.jxl`);
    const p1024 = join(WORK, `${stem}.t1024.jxl`);
    writeFileSync(pFull, fullJxl);
    writeFileSync(p256, j256);
    writeFileSync(p1024, j1024);

    const srcBytes = readFileSync(path).byteLength;
    agg.rawDecodeMs += rawDecodeMs;
    agg.fullEncMs += fullEncMs;
    agg.thumbGenMs += thumbGenMs;
    agg.srcBytes += srcBytes;
    agg.fullBytes += fullJxl.byteLength;
    agg.t256Bytes += j256.byteLength;
    agg.t1024Bytes += j1024.byteLength;

    manifest.push({
      name, master: { w: width, h: height },
      full: { path: pFull, bytes: fullJxl.byteLength },
      t256: { path: p256, bytes: j256.byteLength, w: r256.width, h: r256.height },
      t1024: { path: p1024, bytes: j1024.byteLength, w: r1024.width, h: r1024.height },
    });

    console.log(
      `[${stem}] ${name}  ${width}×${height}  decode ${rawDecodeMs.toFixed(0)}ms  ` +
      `fullEnc ${fullEncMs.toFixed(0)}ms  thumbGen ${thumbGenMs.toFixed(0)}ms  ` +
      `(full ${(fullJxl.byteLength / 1024).toFixed(0)}KB / 256 ${(j256.byteLength / 1024).toFixed(1)}KB / 1024 ${(j1024.byteLength / 1024).toFixed(1)}KB)`
    );
  }

  const wallMs = performance.now() - wallStart;
  writeFileSync(join(WORK, "manifest.json"), JSON.stringify({ dir: GOB_DIR, count: files.length, thumb: THUMB, preview: PREVIEW, items: manifest }, null, 2));

  const n = files.length;
  const mb = (b) => (b / 1024 / 1024).toFixed(1);
  console.log(`\n── Ingest summary (${n} files) ────────────────────────────────`);
  console.log(`wall total           ${(wallMs / 1000).toFixed(1)}s`);
  console.log(`raw decode (sum)     ${(agg.rawDecodeMs / 1000).toFixed(1)}s   (${(agg.rawDecodeMs / n).toFixed(0)} ms/file)`);
  console.log(`full encode (sum)    ${(agg.fullEncMs / 1000).toFixed(1)}s   (${(agg.fullEncMs / n).toFixed(0)} ms/file)`);
  console.log(`THUMBNAIL GEN (sum)  ${(agg.thumbGenMs / 1000).toFixed(1)}s   (${(agg.thumbGenMs / n).toFixed(0)} ms/file)  ← start→stop, 256+1024`);
  console.log(`  thumbnail share of (decode+full+thumb): ${(100 * agg.thumbGenMs / (agg.rawDecodeMs + agg.fullEncMs + agg.thumbGenMs)).toFixed(1)}%`);
  console.log(`\nstored bytes:  source ORF ${mb(agg.srcBytes)}MB → full JXL ${mb(agg.fullBytes)}MB + 256 ${mb(agg.t256Bytes)}MB + 1024 ${mb(agg.t1024Bytes)}MB`);
  console.log(`  pyramid sidecar overhead: ${(100 * (agg.t256Bytes + agg.t1024Bytes) / agg.fullBytes).toFixed(1)}% of full-JXL bytes`);
  console.log(`\nmanifest: ${join(WORK, "manifest.json")}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
