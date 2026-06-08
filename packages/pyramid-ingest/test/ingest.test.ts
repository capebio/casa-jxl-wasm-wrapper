import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setJxlModuleFactoryForTesting } from "@casabio/jxl-wasm";
import {
  formatFromPath, ingestBatch, ingestImage, rebuildIndex, type Backends,
} from "../src/ingest";
import { createJxlBackend, type DecodedMaster, type RawBackend, type RawFormat } from "../src/backends";
import { imageIdForPath } from "../src/hash";
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
  return { raw: fakeRaw(), jxl: createJxlBackend() };
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
    jxl: createJxlBackend(),
  };
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