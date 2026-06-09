import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setJxlModuleFactoryForTesting } from "@casabio/jxl-wasm";
import {
  computeIngestPlan,
  formatFromPath, ingestBatch, ingestImage, rebuildIndex, writeLevelFiles, type Backends, type IngestPlan,
} from "../src/ingest";
import { createJxlBackend, type DecodedMaster, type RawBackend, type RawFormat } from "../src/backends";
import { contentHash16, imageIdForPath } from "../src/hash";
import type { GalleryIndex, Manifest } from "../src/manifest";
import { loadScalarModule, scalarFactory } from "./scalar";

afterEach(() => setJxlModuleFactoryForTesting(null));

const WASM_TIMEOUT = 120_000;

function gradientRgba(w: number, h: number): Uint8Array {
  const px = new Uint8Array(w * h * 4);
  for (let i = 0; i < px.length; i += 4) {
    px[i] = i & 0xff; px[i + 1] = (i >> 3) & 0xff; px[i + 2] = (i >> 6) & 0xff; px[i + 3] = 255;
  }
  return px;
}

function fakeRaw(w = 1280, h = 960): RawBackend {
  return {
    async decode(_bytes: Uint8Array, _format: RawFormat): Promise<DecodedMaster> {
      return { rgba: gradientRgba(w, h), width: w, height: h, orientation: "baked" };
    },
  };
}

async function makeBackends(): Promise<Backends> {
  const module = await loadScalarModule();
  setJxlModuleFactoryForTesting(scalarFactory(module));
  const { makeTestJxlBackend } = await import("./scalar.js");
  const b = { raw: fakeRaw(), jxl: makeTestJxlBackend(), __testInProcess: true } as any;
  return b;
}

async function tmpOut(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pyramid-ingest-"));
}

async function writeMaster(dir: string, name: string): Promise<string> {
  const p = join(dir, name);
  await writeFile(p, new Uint8Array([0, 1, 2, 3]));
  return p;
}

test("formatFromPath maps known extensions (case-insensitive) and rejects others", () => {
  expect(formatFromPath("a/b.ORF")).toBe("orf");
  expect(formatFromPath("a/b.dng")).toBe("dng");
  expect(formatFromPath("a/b.Cr2")).toBe("cr2");
  expect(formatFromPath("a/b.JPG")).toBe("jpg");
  expect(formatFromPath("a/b.jpeg")).toBe("jpg");
  expect(formatFromPath("a/b.png")).toBeNull();
  expect(formatFromPath("noext")).toBeNull();
});

test("ingestImage emits 16-bit big levels when rgb16 is present", { timeout: WASM_TIMEOUT }, async () => {
  const out = await tmpOut();
  const module = await loadScalarModule();
  setJxlModuleFactoryForTesting(scalarFactory(module));
  const packed = new Uint8Array(1280 * 960 * 6);
  for (let i = 0; i < packed.length; i += 6) {
    packed[i] = 200; packed[i + 2] = 100; packed[i + 4] = 50;
  }
  const b: Backends = {
    raw: {
      async decode() {
        return {
          rgba: gradientRgba(1280, 960),
          rgb16: packed,
          width: 1280,
          height: 960,
          orientation: "baked",
        };
      },
    },
    jxl: (await import("./scalar.js")).makeTestJxlBackend(),
    __testInProcess: true,
  } as any;
  const master = await writeMaster(out, "HDR.orf");
  expect(await ingestImage(master, b, { outDir: out })).toBe("written");
  const imageId = imageIdForPath(master);
  const manifest = JSON.parse(await readFile(join(out, "images", imageId, "manifest.json"), "utf8")) as Manifest;
  const grid = manifest.levels.filter((l) => l.size === 256 || l.size === 512 || l.size === 1024);
  const big = manifest.levels.filter((l) => l.size === 2048 || l.size === "full");
  for (const l of grid) expect(l.bitsPerSample).toBe(8);
  for (const l of big) expect(l.bitsPerSample).toBe(16);
});

test("ingestImage writes a full RAW pyramid + manifest, then skips on re-run", { timeout: WASM_TIMEOUT }, async () => {
  const out = await tmpOut();
  const b = await makeBackends();
  const master = await writeMaster(out, "P1.orf");

  expect(await ingestImage(master, b, { outDir: out })).toBe("written");

  const imageId = imageIdForPath(master);
  const manifestPath = join(out, "images", imageId, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Manifest;
  expect(manifest.schema).toBe(1);
  expect(manifest.orientation).toBe("baked");
  expect(manifest.proxy).toBeUndefined();
  expect(manifest.levels.map((l) => l.size)).toEqual([256, 512, 1024, "full"]);
  for (const l of manifest.levels) expect(l.bitsPerSample).toBe(8);
  expect(manifest.producedBy?.tool).toBe("pyramid-ingest");
  expect(manifest.producedBy?.version).toMatch(/^\d+\.\d+\.\d+$/);

  for (const l of manifest.levels) {
    const lf = join(out, "levels", `${l.contenthash}.jxl`);
    expect((await stat(lf)).size).toBe(l.bytes);
  }

  expect(await ingestImage(master, b, { outDir: out })).toBe("skipped");
});

test("force re-ingests even when the manifest is up to date", { timeout: WASM_TIMEOUT }, async () => {
  const out = await tmpOut();
  const b = await makeBackends();
  const master = await writeMaster(out, "P2.orf");
  expect(await ingestImage(master, b, { outDir: out })).toBe("written");
  expect(await ingestImage(master, b, { outDir: out, force: true })).toBe("written");
});

test("identical level content across masters is stored once (content-addressed dedupe)", { timeout: WASM_TIMEOUT }, async () => {
  const out = await tmpOut();
  const b = await makeBackends();
  const m1 = await writeMaster(out, "A.orf");
  const m2 = await writeMaster(out, "B.orf");
  await ingestImage(m1, b, { outDir: out });
  await ingestImage(m2, b, { outDir: out });

  const man1 = JSON.parse(await readFile(join(out, "images", imageIdForPath(m1), "manifest.json"), "utf8")) as Manifest;
  const man2 = JSON.parse(await readFile(join(out, "images", imageIdForPath(m2), "manifest.json"), "utf8")) as Manifest;
  expect(man1.levels.map((l) => l.contenthash)).toEqual(man2.levels.map((l) => l.contenthash));

  const levelFiles = await readdir(join(out, "levels"));
  expect(levelFiles.length).toBe(man1.levels.length);
});

test("computeIngestPlan is side-effect free (no FS writes) and deterministic", async () => {
  const out = await tmpOut();
  // fully synthetic backends: no WASM, deterministic, exercises the pure plan path (decode + ladder + manifest build)
  const fakeJxl = {
    async encodePyramid(_rgba: Uint8Array, w: number, h: number, _opts: any) {
      // produce 2 tiny deterministic levels
      const d1 = new Uint8Array([1, 2, 3]);
      const d2 = new Uint8Array([4, 5, 6, 7]);
      return [
        { data: d1, width: 8, height: 6 },
        { data: d2, width: w, height: h },
      ];
    },
    async encodeTileContainer() { return new Uint8Array([9]); },
    async transcodeJpeg(b: Uint8Array) { return b; },
    async decodeToRgba8(b: Uint8Array) { return { rgba: b, width: 4, height: 3 }; },
  };
  const b: Backends = {
    raw: {
      async decode(_bytes: Uint8Array, _fmt: any) {
        return { rgba: new Uint8Array(16), width: 4, height: 4, orientation: "baked" };
      },
    },
    jxl: fakeJxl as any,
    __testInProcess: true,
  } as any;
  const bytes = new Uint8Array(64);
  const format: "orf" = "orf";
  const identity = { imageId: "0123456789abcdef", masterName: "synthetic.orf", mtimeMs: 1234567890000 };

  // first compute
  const plan1 = await computeIngestPlan(bytes, format, b, identity, { outDir: out, force: false });
  // assert plan shape (pure data)
  expect(plan1.imageId).toBe(identity.imageId);
  expect(plan1.levels.length).toBe(2);
  expect(plan1.manifest.imageId).toBe(identity.imageId);
  expect(plan1.manifest.schema).toBe(1);
  expect(plan1.manifest.levels.length).toBe(2);

  // second compute identical inputs -> identical output (deterministic, including content hashes from bytes)
  const plan2 = await computeIngestPlan(bytes, format, b, identity, { outDir: out, force: false });
  expect(plan2.imageId).toBe(plan1.imageId);
  expect(plan2.levels.length).toBe(plan1.levels.length);
  expect(plan2.manifest.levels.map((l) => l.contenthash)).toEqual(plan1.manifest.levels.map((l) => l.contenthash));
  expect(plan2.levels[0]!.data.length).toBe(plan1.levels[0]!.data.length);

  // side-effect free: compute must not have created images/ or levels/ under the outDir passed in opts
  const imgs = await readdir(out).catch(() => [] as string[]);
  expect(imgs).not.toContain("images");
  expect(imgs).not.toContain("levels");

  // also verify no manifest was written as a side effect
  const manPath = join(out, "images", identity.imageId, "manifest.json");
  await expect(readFile(manPath)).rejects.toThrow();
});

test("proxy mode writes exactly one level and flags the manifest", { timeout: WASM_TIMEOUT }, async () => {
  const out = await tmpOut();
  const b = await makeBackends();
  const master = await writeMaster(out, "P3.orf");
  expect(await ingestImage(master, b, { outDir: out, proxy: 512 })).toBe("written");

  const manifest = JSON.parse(
    await readFile(join(out, "images", imageIdForPath(master), "manifest.json"), "utf8"),
  ) as Manifest;
  expect(manifest.proxy).toBe(true);
  expect(manifest.levels).toHaveLength(1);
  expect(Math.max(manifest.levels[0]!.w, manifest.levels[0]!.h)).toBe(512);
});

test("ingestBatch isolates failures; rebuildIndex inlines L0 for non-proxy images only", { timeout: WASM_TIMEOUT }, async () => {
  const out = await tmpOut();
  const b = await makeBackends();
  const good1 = await writeMaster(out, "G1.orf");
  const good2 = await writeMaster(out, "G2.orf");
  const bad = join(out, "missing.orf");

  const batch = await ingestBatch([good1, good2, bad], b, { outDir: out, concurrency: 2 });
  expect(batch.written).toBe(2);
  expect(batch.skipped).toBe(0);
  expect(batch.failed).toHaveLength(1);
  expect(batch.failed[0]!.path).toBe(bad);

  const proxyMaster = await writeMaster(out, "PX.orf");
  await ingestImage(proxyMaster, b, { outDir: out, proxy: 256 });

  const index = await rebuildIndex(out);
  const ids = index.images.map((e) => e.imageId);
  expect(ids).toContain(imageIdForPath(good1));
  expect(ids).toContain(imageIdForPath(good2));
  expect(ids).not.toContain(imageIdForPath(proxyMaster));
  const g1 = index.images.find((e) => e.imageId === imageIdForPath(good1))!;
  expect(g1.l0.w).toBe(256);
  expect([...ids].sort()).toEqual(ids);

  const onDisk = JSON.parse(await readFile(join(out, "index.json"), "utf8")) as GalleryIndex;
  expect(onDisk.images.length).toBe(index.images.length);
});

test("rebuildIndex skips a corrupt manifest instead of throwing", { timeout: WASM_TIMEOUT }, async () => {
  const out = await tmpOut();
  const b = await makeBackends();
  const good = await writeMaster(out, "OK.orf");
  const broken = await writeMaster(out, "BROKEN.orf");
  await ingestBatch([good, broken], b, { outDir: out, concurrency: 1 });

  const brokenManifest = join(out, "images", imageIdForPath(broken), "manifest.json");
  await writeFile(brokenManifest, "{ not valid json");

  const index = await rebuildIndex(out);
  const ids = index.images.map((e) => e.imageId);
  expect(ids).toContain(imageIdForPath(good));
  expect(ids).not.toContain(imageIdForPath(broken));
});

// === WU-4 durability tests (high-atomic-writes, F10, low-no-retry-on-ebusy, B5/B8/B9) ===

test("high-atomic-writes + EEXIST duplicate: two concurrent writeLevelFiles on same contenthash both succeed, no partial .tmp left", async () => {
  const out = await tmpOut();
  const levelsDir = join(out, "levels");
  await mkdir(levelsDir, { recursive: true });
  const data = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x01, 0x02]);
  const levels = [{ data, width: 2, height: 1 } as any];
  await Promise.all([
    writeLevelFiles(out, levels, 2, 1),
    writeLevelFiles(out, levels, 2, 1),
  ]);
  const files = await readdir(levelsDir);
  const jxls = files.filter((f) => f.endsWith(".jxl"));
  expect(jxls.length).toBe(1);
  const onDisk = await readFile(join(levelsDir, jxls[0]));
  expect(onDisk).toEqual(data);
  const tmps = files.filter((f) => f.endsWith(".tmp"));
  expect(tmps.length).toBe(0);
});

test("B5 high-atomic-writes: write failure mid-execution leaves no partial dest file; next run re-attempts", async () => {
  const out = await tmpOut();
  const b = await makeBackends();
  const master = await writeMaster(out, "PARTIAL.orf");

  // monkey patch fs to throw on first real level dest write (after tmp)
  const fsMod: any = await import("node:fs/promises");
  const origWrite = fsMod.writeFile;
  let writeAttempts = 0;
  fsMod.writeFile = async (p: any, data: any, opts?: any) => {
    if (typeof p === "string" && p.endsWith(".jxl") && !p.includes(".tmp")) {
      writeAttempts++;
      if (writeAttempts === 1) {
        const err: any = new Error("simulated mid-write ENOSPC");
        err.code = "ENOSPC";
        throw err;
      }
    }
    return origWrite(p, data, opts);
  };
  try {
    await expect(ingestImage(master, b, { outDir: out })).rejects.toThrow();
    const levelsDir = join(out, "levels");
    const afterFail = await readdir(levelsDir).catch(() => [] as string[]);
    const realJxls = afterFail.filter((f) => f.endsWith(".jxl") && !f.includes(".tmp"));
    expect(realJxls.length).toBe(0); // no partial left on dest
  } finally {
    fsMod.writeFile = origWrite;
  }

  // re-attempt succeeds (B5)
  const b2 = await makeBackends();
  expect(await ingestImage(master, b2, { outDir: out })).toBe("written");
  const levelsDir = join(out, "levels");
  const files = await readdir(levelsDir);
  expect(files.some((f) => f.endsWith(".jxl"))).toBe(true);
});

test("F10 --verify-hash: corrupt level is overwritten on re-ingest with flag; without flag stays corrupt", async () => {
  const out = await tmpOut();
  const b = await makeBackends();
  const master = await writeMaster(out, "CORRUPT.orf");
  await ingestImage(master, b, { outDir: out });

  const imageId = imageIdForPath(master);
  const man = JSON.parse(await readFile(join(out, "images", imageId, "manifest.json"), "utf8")) as Manifest;
  const full = man.levels.find((l) => l.size === "full") || man.levels[man.levels.length - 1];
  const dest = join(out, "levels", `${full.contenthash}.jxl`);

  // corrupt it
  await writeFile(dest, new Uint8Array([0, 0, 0, 0]));

  // without flag: re-ingest skips (bad stays)
  const b2 = await makeBackends();
  await ingestImage(master, b2, { outDir: out });
  let onDisk = await readFile(dest);
  expect(onDisk.length).toBe(4); // still corrupt

  // with flag: overwrites
  const b3 = await makeBackends();
  await ingestImage(master, b3, { outDir: out, verifyHash: true });
  onDisk = await readFile(dest);
  expect(onDisk.length).toBeGreaterThan(4);
  expect(contentHash16(onDisk)).toBe(full.contenthash);
});

test("low-no-retry-on-ebusy: EBUSY on rename is retried (succeeds on 2nd attempt)", async () => {
  const out = await tmpOut();
  const b = await makeBackends();
  const master = await writeMaster(out, "EBUSY.orf");

  const fsMod: any = await import("node:fs/promises");
  const origRename = fsMod.rename;
  let renameCalls = 0;
  fsMod.rename = async (src: any, dst: any) => {
    renameCalls++;
    if (renameCalls === 1 && typeof dst === "string" && dst.includes(".jxl")) {
      const err: any = new Error("simulated AV EBUSY");
      err.code = "EBUSY";
      throw err;
    }
    return origRename(src, dst);
  };
  try {
    expect(await ingestImage(master, b, { outDir: out })).toBe("written");
    expect(renameCalls).toBeGreaterThanOrEqual(2); // at least one retry happened
  } finally {
    fsMod.rename = origRename;
  }
});

test("B9 index atomic: reader loop never observes partial/truncated index.json during rebuilds", async () => {
  const out = await tmpOut();
  const b = await makeBackends();
  const m1 = await writeMaster(out, "I1.orf");
  const m2 = await writeMaster(out, "I2.orf");
  await ingestBatch([m1, m2], b, { outDir: out });

  let parseErrs = 0;
  const reader = (async () => {
    for (let i = 0; i < 30; i++) {
      try {
        const txt = await readFile(join(out, "index.json"), "utf8");
        JSON.parse(txt);
      } catch {
        parseErrs++;
      }
      await new Promise((r) => setTimeout(r, 3));
    }
  })();

  // concurrent writers (rebuild multiple times)
  for (let i = 0; i < 4; i++) {
    await rebuildIndex(out);
    await new Promise((r) => setTimeout(r, 5));
  }
  await reader;

  expect(parseErrs).toBe(0);
});