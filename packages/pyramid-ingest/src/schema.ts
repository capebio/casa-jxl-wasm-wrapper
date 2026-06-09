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
});

export const masterInfoSchema = z.object({
  name: z.string(),
  format: z.enum(["orf", "dng", "cr2", "jpg"]),
  mtimeMs: z.number(),
});

export const manifestSchemaV1 = z.object({
  schema: z.literal(1),
  imageId: z.string().regex(/^[0-9a-f]{16}$/),
  master: masterInfoSchema,
  orientation: z.enum(["baked", "source"]),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  aspect: z.number().finite().positive(),
  levels: z.array(levelEntrySchema),
  proxy: z.literal(true).optional(),
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
});

function strictPositiveInt(name: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
    throw new Error(`--${name} must be a positive integer; got "${raw}"`);
  }
  return n;
}

export type CliArgs = z.infer<typeof cliArgsSchema>;
