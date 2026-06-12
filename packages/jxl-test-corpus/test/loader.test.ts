import { describe, expect, it } from "bun:test";
import { loadFixture, getFixtures } from "../src/index.js";

describe("jxl-test-corpus loader", () => {
  it("successfully lists all fixtures", () => {
    const fixtures = getFixtures();
    expect(fixtures.length).toBe(10);
    const basic = getFixtures({ tag: "basic" });
    expect(basic.length).toBe(1);
    expect(basic[0].id).toBe("srgb-8bit");
  });

  it("successfully loads a valid local fixture", async () => {
    const { bytes, fixture } = await loadFixture("srgb-8bit");
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.byteLength).toBeGreaterThan(0);
    expect(fixture.id).toBe("srgb-8bit");
    expect(fixture.width).toBe(100);
  });

  it("successfully loads and verifies a 16-bit wide-gamut fixture", async () => {
    const { bytes, fixture } = await loadFixture("adobe-rgb-16bit");
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(fixture.id).toBe("adobe-rgb-16bit");
    expect(fixture.hasIcc).toBe(true);
    expect(fixture.hasExif).toBe(true);
  });

  it("throws a clear error when file is missing or not found", async () => {
    expect(loadFixture("non-existent")).rejects.toThrow("Fixture not found: non-existent");
  });
});
