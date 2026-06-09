import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setJxlModuleFactoryForTesting } from "@casabio/jxl-wasm";
import { collectInputs, main } from "../src/cli";
import {
  createJxlBackend, type DecodedMaster, type RawBackend, type RawFormat,
} from "../src/backends";
import type { Backends } from "../src/ingest";
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

async function scalarBackends(): Promise<Backends> {
  const module = await loadScalarModule();
  setJxlModuleFactoryForTesting(scalarFactory(module));
  const { makeTestJxlBackend } = await import("./scalar.js");
  const b = { raw: fakeRaw(), jxl: makeTestJxlBackend(), __testInProcess: true } as any;
  return b;
}

test("collectInputs walks dirs recursively, keeps supported masters, sorts", async () => {
  const root = await mkdtemp(join(tmpdir(), "pyr-collect-"));
  await mkdir(join(root, "sub"), { recursive: true });
  await writeFile(join(root, "b.orf"), new Uint8Array([0]));
  await writeFile(join(root, "a.jpg"), new Uint8Array([0]));
  await writeFile(join(root, "note.txt"), new Uint8Array([0]));
  await writeFile(join(root, "sub", "c.CR2"), new Uint8Array([0]));
  await writeFile(join(root, "sub", "skip.png"), new Uint8Array([0]));

  const found = await collectInputs([root]);
  const rel = found.map((p) => p.slice(root.length + 1).replaceAll("\\", "/"));
  expect(rel).toEqual(["a.jpg", "b.orf", "sub/c.CR2"]);
});

test("main ingests a directory and writes a gallery index (RAW path via fake backend)", { timeout: WASM_TIMEOUT }, async () => {
  const out = await mkdtemp(join(tmpdir(), "pyr-cli-"));
  const src = await mkdtemp(join(tmpdir(), "pyr-src-"));
  await writeFile(join(src, "one.orf"), new Uint8Array([1]));
  await writeFile(join(src, "two.orf"), new Uint8Array([2]));

  const code = await main(["--out", out, src], await scalarBackends());
  expect(code).toBe(0);

  const index = JSON.parse(await readFile(join(out, "index.json"), "utf8")) as GalleryIndex;
  expect(index.images).toHaveLength(2);
  expect(index.images.map((e) => e.imageId)).toContain(imageIdForPath(join(src, "one.orf")));

  const levelFiles = await readdir(join(out, "levels"));
  expect(levelFiles.length).toBeGreaterThan(0);
});

test("main --proxy writes single-level proxy manifests and skips index rebuild", { timeout: WASM_TIMEOUT }, async () => {
  const out = await mkdtemp(join(tmpdir(), "pyr-cli-px-"));
  const src = await mkdtemp(join(tmpdir(), "pyr-src-px-"));
  await writeFile(join(src, "one.orf"), new Uint8Array([1]));

  const code = await main(["--out", out, "--proxy", "256", src], await scalarBackends());
  expect(code).toBe(0);

  const manifest = JSON.parse(
    await readFile(join(out, "images", imageIdForPath(join(src, "one.orf")), "manifest.json"), "utf8"),
  ) as Manifest;
  expect(manifest.proxy).toBe(true);
  expect(manifest.levels).toHaveLength(1);

  await expect(readFile(join(out, "index.json"), "utf8")).rejects.toThrow();
});

test("main --shard processes only its slice and skips the index; --reindex-only builds it", { timeout: WASM_TIMEOUT }, async () => {
  const out = await mkdtemp(join(tmpdir(), "pyr-cli-sh-"));
  const src = await mkdtemp(join(tmpdir(), "pyr-src-sh-"));
  for (const n of ["a.orf", "b.orf", "c.orf", "d.orf"]) await writeFile(join(src, n), new Uint8Array([1]));

  const code = await main(["--out", out, "--shard", "0/2", src], await scalarBackends());
  expect(code).toBe(0);
  await expect(readFile(join(out, "index.json"), "utf8")).rejects.toThrow();
  expect(await readdir(join(out, "images"))).toHaveLength(2);

  const reindexCode = await main(["--out", out, "--reindex-only"], await scalarBackends());
  expect(reindexCode).toBe(0);
});

test("main --dry-run executes planning but writes nothing", async () => {
  const out = await mkdtemp(join(tmpdir(), "pyr-dry-"));
  const src = await mkdtemp(join(tmpdir(), "pyr-src-dry-"));
  await writeFile(join(src, "dry.orf"), new Uint8Array([9, 9, 9]));

  // provide override backends with pure fake encode so dry-run path exercises compute without real WASM symbols
  const fakeJxl: any = {
    async encodePyramid(_r: Uint8Array, w: number, h: number) {
      return [{ data: new Uint8Array([1, 2]), width: 2, height: 1 }, { data: new Uint8Array([3]), width: w, height: h }];
    },
    async encodeTileContainer() { return new Uint8Array(1); },
    async transcodeJpeg(b: Uint8Array) { return b; },
    async decodeToRgba8(b: Uint8Array) { return { rgba: b, width: 1, height: 1 }; },
  };
  const fakeB: Backends = {
    raw: { async decode(_b: Uint8Array, _f: any) { return { rgba: new Uint8Array(4), width: 1, height: 1, orientation: "baked" }; } },
    jxl: fakeJxl,
    __testInProcess: true,
  } as any;

  const code = await main(["--out", out, "--dry-run", src], fakeB);
  expect(code).toBe(0);

  // no output tree written (dry-run skips apply)
  await expect(readdir(join(out, "images"))).rejects.toThrow();
  await expect(readdir(join(out, "levels"))).rejects.toThrow();
});

test("main rejects bad numeric CLI flags with clear error (high-cli-nan)", async () => {
  const out = await mkdtemp(join(tmpdir(), "pyr-cli-bad-"));
  const src = await mkdtemp(join(tmpdir(), "pyr-src-bad-"));
  await writeFile(join(src, "one.orf"), new Uint8Array([1]));
  const b = await scalarBackends();

  await expect(main(["--out", out, "--proxy", "abc", src], b)).rejects.toThrow(/--proxy must be a positive integer/);
  await expect(main(["--out", out, "--concurrency", "NaN", src], b)).rejects.toThrow(/--concurrency must be a positive integer/);
  await expect(main(["--out", out, "--mem-budget-mb", "0", src], b)).rejects.toThrow(/--mem-budget-mb must be a positive integer/);
});