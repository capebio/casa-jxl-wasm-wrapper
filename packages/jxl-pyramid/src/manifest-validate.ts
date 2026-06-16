// manifest-validate.ts
// Hand-rolled runtime validation for PyramidManifest and GalleryIndex.
// Types-only import from manifest.ts — no zod dependency.

import type {
  PyramidManifest,
  PyramidLevel,
  GalleryIndex,
  GalleryIndexEntry,
  LevelZeroSeed,
  MasterMetadata,
  ProducedBy,
} from "./manifest.js";

export const MANIFEST_SCHEMA_VERSION = 2;
export const INDEX_SCHEMA_VERSION = 1;

export class ManifestValidationError extends Error {
  constructor(message: string, public readonly path: string) {
    super(`${path}: ${message}`);
    this.name = "ManifestValidationError";
  }
}

function fail(path: string, msg: string): never {
  throw new ManifestValidationError(msg, path);
}

function requireString(v: unknown, path: string): string {
  if (typeof v !== "string") fail(path, `expected string, got ${typeof v}`);
  return v as string;
}

function requireNumber(v: unknown, path: string): number {
  if (typeof v !== "number" || !isFinite(v)) fail(path, `expected finite number, got ${JSON.stringify(v)}`);
  return v as number;
}

function requireBoolean(v: unknown, path: string): boolean {
  if (typeof v !== "boolean") fail(path, `expected boolean, got ${typeof v}`);
  return v as boolean;
}

function requireObject(v: unknown, path: string): Record<string, unknown> {
  if (v == null || typeof v !== "object" || Array.isArray(v)) fail(path, `expected object, got ${Array.isArray(v) ? "array" : typeof v}`);
  return v as Record<string, unknown>;
}

function requireArray(v: unknown, path: string): unknown[] {
  if (!Array.isArray(v)) fail(path, `expected array, got ${typeof v}`);
  return v as unknown[];
}

function validateMasterMetadata(v: unknown, path: string): MasterMetadata {
  const o = requireObject(v, path);
  const name = requireString(o["name"], `${path}.name`);
  const format = requireString(o["format"], `${path}.format`);
  if (!["orf", "dng", "cr2", "jpg"].includes(format)) {
    fail(`${path}.format`, `unknown format "${format}"`);
  }
  const mtimeMs = requireNumber(o["mtimeMs"], `${path}.mtimeMs`);
  const result: MasterMetadata = { name, format: format as MasterMetadata["format"], mtimeMs };
  if (o["sizeBytes"] !== undefined) result.sizeBytes = requireNumber(o["sizeBytes"], `${path}.sizeBytes`);
  return result;
}

function validateProducedBy(v: unknown, path: string): ProducedBy {
  const o = requireObject(v, path);
  const tool = requireString(o["tool"], `${path}.tool`);
  const version = requireString(o["version"], `${path}.version`);
  const result: ProducedBy = { tool, version };
  if (o["params"] !== undefined) {
    requireObject(o["params"], `${path}.params`);
    result.params = o["params"] as Record<string, unknown>;
  }
  return result;
}

function validateLevel(v: unknown, path: string): PyramidLevel {
  const o = requireObject(v, path);
  const size = o["size"];
  if (size !== "full" && (typeof size !== "number" || !isFinite(size as number) || (size as number) <= 0)) {
    fail(`${path}.size`, `expected positive number or "full", got ${JSON.stringify(size)}`);
  }
  const w = requireNumber(o["w"], `${path}.w`);
  const h = requireNumber(o["h"], `${path}.h`);
  const bytes = requireNumber(o["bytes"], `${path}.bytes`);
  const bitsPerSample = requireNumber(o["bitsPerSample"], `${path}.bitsPerSample`);
  if (bitsPerSample !== 8 && bitsPerSample !== 16) {
    fail(`${path}.bitsPerSample`, `expected 8 or 16, got ${bitsPerSample}`);
  }
  const contenthash = requireString(o["contenthash"], `${path}.contenthash`);
  if (contenthash.length === 0) fail(`${path}.contenthash`, "must not be empty");
  const tiled = requireBoolean(o["tiled"], `${path}.tiled`);

  const level: PyramidLevel = {
    size: size as PyramidLevel["size"],
    w, h, bytes,
    bitsPerSample: bitsPerSample as PyramidLevel["bitsPerSample"],
    contenthash,
    tiled,
  };

  if (tiled) {
    if (o["tiling"] == null) fail(`${path}.tiling`, "required when tiled=true");
    const t = requireObject(o["tiling"], `${path}.tiling`);
    level.tiling = {
      tileSize: requireNumber(t["tileSize"], `${path}.tiling.tileSize`),
      cols: requireNumber(t["cols"], `${path}.tiling.cols`),
      rows: requireNumber(t["rows"], `${path}.tiling.rows`),
    };
  }

  if (o["convergedByteEnd"] !== undefined) {
    const cbe = requireNumber(o["convergedByteEnd"], `${path}.convergedByteEnd`);
    if (cbe > bytes) fail(`${path}.convergedByteEnd`, `${cbe} exceeds bytes ${bytes}`);
    level.convergedByteEnd = cbe;
  }

  if (o["qualityCurve"] !== undefined) {
    const arr = requireArray(o["qualityCurve"], `${path}.qualityCurve`);
    level.qualityCurve = arr.map((pt, i) => {
      const p = requireObject(pt, `${path}.qualityCurve[${i}]`);
      const ptBytes = requireNumber(p["bytes"], `${path}.qualityCurve[${i}].bytes`);
      const point: PyramidLevel["qualityCurve"] extends Array<infer T> ? T : never = { bytes: ptBytes };
      if (p["ssim"] !== undefined) (point as any).ssim = requireNumber(p["ssim"], `${path}.qualityCurve[${i}].ssim`);
      if (p["butteraugli"] !== undefined) (point as any).butteraugli = requireNumber(p["butteraugli"], `${path}.qualityCurve[${i}].butteraugli`);
      return point as NonNullable<PyramidLevel["qualityCurve"]>[number];
    });
  }

  return level;
}

/**
 * Accepts schema 1|2 (normalizes 1 → 2 defaults: stub=false, proxy=false).
 * Throws ManifestValidationError on schema > 2 or missing/invalid fields.
 */
export function parsePyramidManifest(json: unknown): PyramidManifest {
  const o = requireObject(json, "manifest");
  const schema = requireNumber(o["schema"], "manifest.schema");

  if (schema > MANIFEST_SCHEMA_VERSION) {
    fail("manifest.schema", `schema ${schema} is newer than reader (max ${MANIFEST_SCHEMA_VERSION}); upgrade the reader`);
  }
  if (schema < 1) {
    fail("manifest.schema", `unsupported schema version ${schema}`);
  }

  const imageId = requireString(o["imageId"], "manifest.imageId");
  const master = validateMasterMetadata(o["master"], "manifest.master");
  const orientation = requireString(o["orientation"], "manifest.orientation");
  if (orientation !== "baked" && orientation !== "source") {
    fail("manifest.orientation", `expected "baked" or "source", got "${orientation}"`);
  }
  const width = requireNumber(o["width"], "manifest.width");
  const height = requireNumber(o["height"], "manifest.height");
  const aspect = requireNumber(o["aspect"], "manifest.aspect");

  if (Math.abs(aspect - width / height) > 1e-3) {
    fail("manifest.aspect", `aspect ${aspect} inconsistent with width/height ratio ${width}/${height} = ${(width / height).toFixed(6)}`);
  }

  const levelsRaw = requireArray(o["levels"], "manifest.levels");
  if (levelsRaw.length === 0) fail("manifest.levels", "must not be empty");

  const levels = levelsRaw.map((l, i) => validateLevel(l, `manifest.levels[${i}]`));

  // Sizes must be strictly ascending numerically, with "full" last.
  for (let i = 1; i < levels.length; i++) {
    const prev = levels[i - 1].size;
    const curr = levels[i].size;
    if (prev === "full") {
      // "full" at i-1 means i-1 was not the last — report at the "full" level's path
      fail(`manifest.levels[${i - 1}].size`, `"full" must be the last level`);
    } else if (curr !== "full" && (curr as number) <= (prev as number)) {
      fail(`manifest.levels[${i}].size`, `sizes must be strictly ascending: ${curr} <= ${prev}`);
    }
  }

  const result: PyramidManifest = {
    schema: 2, // normalize schema 1 → 2
    imageId,
    master,
    orientation: orientation as PyramidManifest["orientation"],
    width,
    height,
    aspect,
    levels,
    // schema 1 normalization defaults
    stub: schema === 1 ? false : (typeof o["stub"] === "boolean" ? o["stub"] : undefined),
    proxy: schema === 1 ? false : (typeof o["proxy"] === "boolean" ? o["proxy"] : undefined),
  };

  if (o["producedBy"] !== undefined) result.producedBy = validateProducedBy(o["producedBy"], "manifest.producedBy");
  if (o["metadata"] !== undefined) { requireObject(o["metadata"], "manifest.metadata"); result.metadata = o["metadata"] as Record<string, unknown>; }
  if (o["convergedByteEnd"] !== undefined) result.convergedByteEnd = requireNumber(o["convergedByteEnd"], "manifest.convergedByteEnd");

  return result;
}

function validateLevelZeroSeed(v: unknown, path: string): LevelZeroSeed {
  const o = requireObject(v, path);
  const contenthash = requireString(o["contenthash"], `${path}.contenthash`);
  if (contenthash.length === 0) fail(`${path}.contenthash`, "must not be empty");
  const w = requireNumber(o["w"], `${path}.w`);
  const h = requireNumber(o["h"], `${path}.h`);
  const result: LevelZeroSeed = { contenthash, w, h };
  if (o["bytes"] !== undefined) result.bytes = requireNumber(o["bytes"], `${path}.bytes`);
  return result;
}

function validateGalleryIndexEntry(v: unknown, path: string): GalleryIndexEntry {
  const o = requireObject(v, path);
  const imageId = requireString(o["imageId"], `${path}.imageId`);
  const aspect = requireNumber(o["aspect"], `${path}.aspect`);
  const l0 = validateLevelZeroSeed(o["l0"], `${path}.l0`);
  const result: GalleryIndexEntry = { imageId, aspect, l0 };
  if (o["thumbhash"] !== undefined) result.thumbhash = requireString(o["thumbhash"], `${path}.thumbhash`);
  if (o["group"] !== undefined) result.group = requireString(o["group"], `${path}.group`);
  return result;
}

export function parseGalleryIndex(json: unknown): GalleryIndex {
  const o = requireObject(json, "index");
  const schema = requireNumber(o["schema"], "index.schema");
  if (schema !== INDEX_SCHEMA_VERSION) {
    fail("index.schema", `expected schema ${INDEX_SCHEMA_VERSION}, got ${schema}`);
  }
  const imagesRaw = requireArray(o["images"], "index.images");
  const images = imagesRaw.map((e, i) => validateGalleryIndexEntry(e, `index.images[${i}]`));
  const result: GalleryIndex = { schema: 1, images };
  if (o["next"] !== undefined) result.next = requireString(o["next"], "index.next");
  return result;
}
