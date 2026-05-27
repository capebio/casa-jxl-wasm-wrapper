import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/loader.ts", import.meta.url), "utf8");

test("node wasm loader compiles fs bytes directly without ArrayBuffer slice copy", () => {
  expect(source).toContain("return WebAssembly.compile(bytes as BufferSource);");
  expect(source).not.toContain("bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)");
});
