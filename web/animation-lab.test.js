import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

test("animation-lab.html exists and contains key elements", () => {
  const html = readFileSync(resolve(import.meta.dir, "animation-lab.html"), "utf8");
  expect(html).toContain("animation-lab");
  expect(html).toContain("ticksPerSecond");
  expect(html).toContain("loopCount");
  expect(html).toContain("encodeAnimation");
  expect(html).toContain("frameCount");
});
