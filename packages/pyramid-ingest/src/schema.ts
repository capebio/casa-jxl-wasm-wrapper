import { z } from "zod";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

let cachedVersion: string | null = null;

function getVersion(): string {
  if (cachedVersion) return cachedVersion;
  const url = new URL("../package.json", import.meta.url);
  const txt = readFileSync(fileURLToPath(url), "utf8");
  const pkg = JSON.parse(txt) as { version: string };
  cachedVersion = pkg.version;
  return cachedVersion;
}

export const producedBySchema = z.object({
  tool: z.literal("pyramid-ingest"),
  version: z.string(),
  encoder: z.object({
    libjxl: z.string().optional(),
    effort: z.number().int().positive(),
    quality: z.object({
      grid: z.number().int().min(30).max(100),
      big: z.number().int().min(30).max(100),
      proxy: z.number().int().min(30).max(100),
    }),
  }),
});

export const levelSizeSchema = z.union([z.number().int().positive(), z.literal("full")]);

export const levelEntrySchema = z.object({
  size: levelSizeSchema,
  w: z.number().int().positive(),
  h: z.number().int().positive(),
  bytes: z.number().int().nonnegative(),
  bitsPerSample: z.union([z.literal(8), z.literal(16)]),
  contenthash: z.string().length(16),
  tiled: z.boolean(),
  convergedByteEnd: z.number().int().positive().optional(),
});

export const masterInfoSchema = z.object({
  name: z.string(),
  format: z.enum(["orf", "dng", "cr2", "jpg", "nef", "arw", "raf", "rw2", "unknown"]),
  mtimeMs: z.number(),
});

export const manifestSchemaV1 = z.object({
  schema: z.literal(1),
  imageId: z.string().regex(/^[0-9a-f]{16}$/),
  master: masterInfoSchema,
  orientation: z.enum(["baked", "source"]).optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  aspect: z.number().finite().positive().optional(),
  levels: z.array(levelEntrySchema).optional(),
  proxy: z.literal(true).optional(),
  stub: z.literal(true).optional(),
  metadata: z.record(z.unknown()).optional(),
  producedBy: producedBySchema
    .refine((p) => {
      const maj = (p.version || "").split(".")[0];
      return maj === "0";
    }, { message: "unsupported producedBy major version" })
    .optional(),
});

export const indexEntrySchema = z.object({
  imageId: z.string().regex(/^[0-9a-f]{16}$/),
  aspect: z.number().finite().positive(),
  l0: z.object({
    contenthash: z.string().length(16),
    w: z.number().int().positive(),
    h: z.number().int().positive(),
  }),
});

export const galleryIndexSchema = z.object({
  schema: z.literal(1),
  images: z.array(indexEntrySchema),
});

export type Manifest = z.infer<typeof manifestSchemaV1>;
export type IndexEntry = z.infer<typeof indexEntrySchema>;
export type GalleryIndex = z.infer<typeof galleryIndexSchema>;
export type LevelEntry = z.infer<typeof levelEntrySchema>;
export type LevelSize = z.infer<typeof levelSizeSchema>;
export type MasterInfo = z.infer<typeof masterInfoSchema>;
export type ProducedBy = z.infer<typeof producedBySchema>;

export function parseManifest(text: string): Manifest {
  return manifestSchemaV1.parse(JSON.parse(text));
}

export function parseGalleryIndex(text: string): GalleryIndex {
  return galleryIndexSchema.parse(JSON.parse(text));
}

const EFFORT = 3;
const GRID_QUALITY = 85;
const BIG_QUALITY = 95;
const PROXY_QUALITY = 85;

export function makeProducedBy(): ProducedBy {
  return {
    tool: "pyramid-ingest",
    version: getVersion(),
    encoder: {
      effort: EFFORT,
      quality: {
        grid: GRID_QUALITY,
        big: BIG_QUALITY,
        proxy: PROXY_QUALITY,
      },
    },
  };
}

export const cliArgsSchema = z.object({
  out: z.string(),
  proxy: z
    .string()
    .optional()
    .transform((v) => (v === undefined ? undefined : strictPositiveInt("proxy", v))),
  force: z.boolean().optional().default(false),
  concurrency: z
    .string()
    .optional()
    .transform((v) => (v === undefined ? undefined : strictPositiveInt("concurrency", v))),
  "mem-budget-mb": z
    .string()
    .optional()
    .transform((v) => (v === undefined ? 4096 : strictPositiveInt("mem-budget-mb", v))),
  shard: z
    .string()
    .optional()
    .refine((v) => !v || /^\d+\/\d+$/.test(v), {
      message: '--shard must be "i/N" (0-based)',
    }),
  tier: z.enum(["simd", "scalar", "auto"]).optional().default("simd"),
  "reindex-only": z.boolean().optional().default(false),
  "encoder-threads": z
    .string()
    .optional()
    .transform((v) => (v === undefined ? undefined : strictPositiveInt("encoder-threads", v))),
  verbose: z.boolean().optional().default(false),
  "verify-hash": z.boolean().optional().default(false),
  "dry-run": z.boolean().optional().default(false),
  explain: z.string().optional(),
  "timeout-ms": z
    .string()
    .optional()
    .transform((v) => (v === undefined ? undefined : strictPositiveInt("timeout-ms", v))),
  "accept-unsupported": z.boolean().optional().default(true),
  "profile-convergence": z.boolean().optional().default(false),
});

function strictPositiveInt(name: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
    throw new Error(`--${name} must be a positive integer; got "${raw}"`);
  }
  return n;
}

export type CliArgs = z.infer<typeof cliArgsSchema>;

/** Magic-byte signatures for adversarial unknown-RAW detection (colocated with Zod per Q6). // WU-5-8 handoff safe-concurrency

 *  Used only for Tier-3/5 fallback when native Tier-1 decode fails or ext unknown.
 *  Prefix matches (order: more specific first if needed).
 */
export const RAW_MAGIC_SIGNATURES: Array<{ format: string; bytes: number[]; offset: number }> = [
  { format: "cr2", bytes: [0x49, 0x49, 0x2a, 0x00], offset: 0 }, // II*\0 (tiff) + CR2 maker later
  { format: "orf", bytes: [0x49, 0x49, 0x52, 0x4f], offset: 0 }, // IIRO (Olympus)
  { format: "dng", bytes: [0x49, 0x49, 0x2a, 0x00], offset: 0 },
  { format: "nef", bytes: [0x4d, 0x4d, 0x00, 0x2a], offset: 0 }, // MM\0* or II variant + Nikon
  { format: "arw", bytes: [0x49, 0x49, 0x2a, 0x00], offset: 0 }, // Sony (tiff base)
  { format: "raf", bytes: [0x46, 0x55, 0x4a, 0x49], offset: 0 }, // FUJI start
];

export function detectFormatByMagic(bytes: Uint8Array): string | null {
  for (const sig of RAW_MAGIC_SIGNATURES) {
    const off = sig.offset | 0;
    if (bytes.length >= off + sig.bytes.length) {
      let ok = true;
      for (let i = 0; i < sig.bytes.length; i++) {
        if (bytes[off + i] !== sig.bytes[i]) { ok = false; break; }
      }
      if (ok) return sig.format;
    }
  }
  return null;
}
