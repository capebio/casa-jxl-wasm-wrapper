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
  return { raw: fakeRaw(), jxl: createJxlBackend() };
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
  const index = JSON.parse(await readFile(join(out, "index.json"), "utf8")) as GalleryIndex;
  expect(index.images).toHaveLength(2);
});