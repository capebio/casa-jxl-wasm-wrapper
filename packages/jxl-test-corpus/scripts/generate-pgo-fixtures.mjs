#!/usr/bin/env node
import { cp, mkdir, writeFile, rm, readdir, access } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { decodeRawToRgba, initRawWasm } from "../../../benchmark/optimal-settings-timing-utils.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(__dirname, "..");
const corpusRoot = packageRoot;
const tilesDir = join(corpusRoot, "tiles", "256");
const fullDir = join(corpusRoot, "full");
const withMetaDir = join(fullDir, "withmeta");
const manifestPath = join(packageRoot, "pgo-manifest.json");

const DEFAULT_SOURCES = [
  String.raw`C:\995\2026-02-20 Gobabeb To Windhoek\P2200694 Hermannia.ORF`,
  String.raw`C:\995\2026-02-20 Gobabeb To Windhoek\P2200693 Hermannia sanguinea.ORF`,
  String.raw`C:\995\2026-02-20 Gobabeb To Windhoek\P2200692.ORF`,
];

/**
 * Creates the static configuration for PGO training.
 * @returns {import('../src/types.js').PgoScenarioManifest}
 */
export function makePgoScenarioManifest() {
  return {
    version: 2,
    scenarios: [
      {
        name: "gallery-scroll",
        weight: 0.6,
        op: "encode-tiles",
        files: ["tiles/256/*.ppm"],
        effort: 3,
        note: "Q8 256px tile ladder, dominant ingest op"
      },
      {
        name: "pyramid-ladder",
        weight: 0.25,
        op: "encode-pyramid",
        files: ["full/*.ppm"],
        effort: 3,
        levels: 5
      },
      {
        name: "metadata-sidecars",
        weight: 0.1,
        op: "encode-container",
        files: ["full/withmeta/*.ppm"],
        effort: 3,
        note: "same pixels, metadata exercised in trainer"
      },
      {
        name: "hiquality-archival",
        weight: 0.05,
        op: "encode",
        files: ["full/*.ppm"],
        effort: 7,
        note: "high-effort search coverage on full-frame sources"
      }
    ]
  };
}

/**
 * Resolves raw sources dynamically using environment variables, directory scans,
 * or the default hardcoded fallbacks.
 */
async function resolveSources() {
  const sourceDirEnv = process.env.PGO_SOURCE_DIR;
  if (sourceDirEnv) {
    try {
      const entries = await readdir(sourceDirEnv);
      const raws = entries
        .filter(f => /\.(orf|dng|raw|cr2)$/i.test(f))
        .map(f => join(sourceDirEnv, f));
      if (raws.length > 0) {
        return raws.slice(0, 3);
      }
    } catch (e) {
      console.warn(`[pgo-corpus] Failed to scan PGO_SOURCE_DIR: ${e.message}`);
    }
  }

  const existing = [];
  for (const s of DEFAULT_SOURCES) {
    try {
      await access(s);
      existing.push(s);
    } catch {}
  }

  if (existing.length === 0) {
    throw new Error('No PGO source RAWs found. Pass paths as args or set PGO_SOURCE_DIR.');
  }
  return existing;
}

export function pickPgoSourceFiles({ sources = DEFAULT_SOURCES, limit = sources.length } = {}) {
  // Default: use ALL provided sources (a richer/diverse corpus yields better PGO
  // branch coverage). Cap only via explicit `limit` or PGO_SOURCE_LIMIT.
  const cap = process.env.PGO_SOURCE_LIMIT ? Number(process.env.PGO_SOURCE_LIMIT) : limit;
  return sources.slice(0, cap);
}

/**
 * In-process downscaler to avoid doing double RAW decode per source.
 * Box/area-average downscales RGBA8 pixels to target longest edge size.
 */
function downscaleRgba(rgba, width, height, targetMaxEdge) {
  const scale = targetMaxEdge / Math.max(width, height);
  if (scale >= 1.0) {
    return { rgba: new Uint8Array(rgba), width, height };
  }
  const dstW = Math.round(width * scale);
  const dstH = Math.round(height * scale);
  const dst = new Uint8Array(dstW * dstH * 4);
  
  for (let dy = 0; dy < dstH; dy++) {
    const syMin = dy / scale;
    const syMax = (dy + 1) / scale;
    for (let dx = 0; dx < dstW; dx++) {
      const sxMin = dx / scale;
      const sxMax = (dx + 1) / scale;
      
      let rSum = 0, gSum = 0, bSum = 0, aSum = 0, wSum = 0;
      for (let sy = Math.floor(syMin); sy < Math.ceil(syMax); sy++) {
        if (sy < 0 || sy >= height) continue;
        const yWeight = Math.min(sy + 1, syMax) - Math.max(sy, syMin);
        for (let sx = Math.floor(sxMin); sx < Math.ceil(sxMax); sx++) {
          if (sx < 0 || sx >= width) continue;
          const xWeight = Math.min(sx + 1, sxMax) - Math.max(sx, sxMin);
          const weight = yWeight * xWeight;
          
          const srcIdx = (sy * width + sx) * 4;
          rSum += rgba[srcIdx] * weight;
          gSum += rgba[srcIdx + 1] * weight;
          bSum += rgba[srcIdx + 2] * weight;
          aSum += rgba[srcIdx + 3] * weight;
          wSum += weight;
        }
      }
      
      const dstIdx = (dy * dstW + dx) * 4;
      if (wSum > 0) {
        dst[dstIdx] = Math.round(rSum / wSum);
        dst[dstIdx + 1] = Math.round(gSum / wSum);
        dst[dstIdx + 2] = Math.round(bSum / wSum);
        dst[dstIdx + 3] = Math.round(aSum / wSum);
      }
    }
  }
  return { rgba: dst, width: dstW, height: dstH };
}

/**
 * Generates PGO training PPM fixtures.
 * @param {Object} [options]
 * @param {string[]} [options.sources]
 * @returns {Promise<{ manifest: import('../src/types.js').PgoScenarioManifest, generated: any[] }>}
 */
export async function generatePgoFixtures({ sources = [] } = {}) {
  const baseSources = sources.length > 0 ? sources : await resolveSources();
  const picked = pickPgoSourceFiles({ sources: baseSources });
  await initRawWasm();

  // Clear output directories to avoid stale orphans poisoning PGO training
  await rm(tilesDir, { recursive: true, force: true });
  await rm(fullDir, { recursive: true, force: true });

  await mkdir(tilesDir, { recursive: true });
  await mkdir(fullDir, { recursive: true });
  await mkdir(withMetaDir, { recursive: true });

  const generated = [];
  for (const source of picked) {
    const stem = sanitizeStem(source);
    
    // Decode full resolution RAW once
    const full = decodeRawToRgba(source, Number.MAX_SAFE_INTEGER);
    
    // Downscale full resolution RGBA in-process to create 256px tile
    const tile = downscaleRgba(full.rgba, full.width, full.height, 256);

    const tilePath = join(tilesDir, `${stem}.ppm`);
    const fullPath = join(fullDir, `${stem}.ppm`);
    const withMetaPath = join(withMetaDir, `${stem}.ppm`);

    await writePpm(tilePath, tile.rgba, tile.width, tile.height);
    await writePpm(fullPath, full.rgba, full.width, full.height);
    await cp(fullPath, withMetaPath, { force: true });

    generated.push({
      source,
      tilePath,
      fullPath,
      withMetaPath,
      tile: { width: tile.width, height: tile.height },
      full: { width: full.width, height: full.height }
    });
  }

  const baseManifest = makePgoScenarioManifest();
  
  // Validate weight invariant
  const totalWeight = baseManifest.scenarios.reduce((sum, s) => sum + s.weight, 0);
  if (Math.abs(totalWeight - 1.0) >= 1e-9) {
    throw new Error(`PGO scenario weights must sum to 1.0; got ${totalWeight}`);
  }

  // Inject provenance metadata block
  const manifest = {
    ...baseManifest,
    generated: {
      at: new Date().toISOString(),
      sources: generated.map(g => ({
        source: basename(g.source),
        full: g.full,
        tile: g.tile
      }))
    }
  };

  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { manifest, generated };
}

/**
 * Hardened writePpm helper with single allocation and stride safety checks
 */
async function writePpm(path, rgba, width, height) {
  // Stride safety guard
  if (rgba.byteLength !== width * height * 4) {
    throw new Error(`rgba stride mismatch for PPM write at ${path}: expected ${width * height * 4} bytes, got ${rgba.byteLength}`);
  }

  const headerStr = `P6\n${width} ${height}\n255\n`;
  const out = Buffer.allocUnsafe(headerStr.length + width * height * 3);
  out.write(headerStr, 0, 'ascii');

  for (let src = 0, dst = headerStr.length; src < rgba.byteLength; src += 4, dst += 3) {
    out[dst] = rgba[src];
    out[dst + 1] = rgba[src + 1];
    out[dst + 2] = rgba[src + 2];
  }

  await writeFile(path, out);
}

function sanitizeStem(path) {
  return basename(path, extname(path)).replace(/[^\w.-]+/g, "_");
}

async function main() {
  const result = await generatePgoFixtures({
    sources: process.argv.slice(2).length > 0 ? process.argv.slice(2) : []
  });
  console.log(`[pgo-corpus] wrote ${result.generated.length} source fixture sets to ${corpusRoot}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
