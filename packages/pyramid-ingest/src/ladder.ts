import type { JxlBackend, PyramidEncodeOptions, PyramidLevelBytes, RawBackend } from "./backends.js";

/** Build the ladder for RAW. M3: grid levels 8-bit, {2048, full} use 16-bit data (from raw rgb16) if available. Separate encodes since bit depth differs. */
export async function buildRawLadder(
  jxl: JxlBackend,
  decoded: { rgba: Uint8Array; rgb16?: Uint8Array; width: number; height: number },
  width: number,
  height: number,
  plan: PyramidEncodeOptions,
): Promise<PyramidLevelBytes[]> {
  const { rgba, rgb16 } = decoded;
  const is16 = !!rgb16 && plan.sidecarSizes.some(s => s >= 2048 || s === 'full' as any); // rough

  if (rgb16 && (plan.sidecarSizes.includes(2048) || plan.sidecarSizes.some(s => typeof s === 'number' && s >= 2048))) {
    // M3: split: grid sizes (256/512/1024) use 8-bit encode, big use 16-bit encode.
    const gridSizes = plan.sidecarSizes.filter(s => (typeof s === 'number' && s < 2048) || s === 2048 /* wait, 2048 is big */);
    // Simpler: grid <2048 use 8, 2048+full use 16.
    const smallSizes = plan.sidecarSizes.filter((s) => typeof s === 'number' && s <= 1024);
    const bigSizes = plan.sidecarSizes.filter((s) => s === 2048 || s === 'full' as any);

    let levels: PyramidLevelBytes[] = [];
    if (smallSizes.length > 0) {
      const smallPlan = { ...plan, sidecarSizes: smallSizes, sidecarDistances: plan.sidecarDistances.slice(0, smallSizes.length) };
      const small = await jxl.encodePyramid(rgba, width, height, smallPlan);
      levels = levels.concat(small);
    }
    if (bigSizes.length > 0 && rgb16) {
      const bigPlan = { ...plan, sidecarSizes: bigSizes, sidecarDistances: plan.sidecarDistances.slice(smallSizes.length) };
      const big = await jxl.encodePyramid16(rgb16, width, height, bigPlan);
      levels = levels.concat(big);
    }
    // full may be included in big.
    return levels;
  }

  // Fallback / M1 8-bit only
  return jxl.encodePyramid(rgba, width, height, plan);
}

/** For JPG: transcode to get the lossless full level, decode it once to RGBA8, then sidecar the smaller levels only (drop re-encode full). */
export async function buildJpgLadder(
  jxl: JxlBackend,
  jpeg: Uint8Array,
  plan: PyramidEncodeOptions,
): Promise<{ levels: PyramidLevelBytes[]; fullTranscoded: Uint8Array }> {
  const transcodedFull = await jxl.transcodeJpeg(jpeg);
  // Decode the transcoded JXL once to get RGBA for the sidecar levels.
  const decoded = await jxl.decodeToRgba8(transcodedFull);
  // Use the sidecar plan but with sizes; the encode will skip sizes >= master long edge.
  // To avoid re-encoding full, we call with the sidecarSizes only (no "full" in sidecars for JPG).
  // The planLadder includes 2048 as sidecar; for JPG the "full" is the transcoded one.
  // To build the smalls, pass the sidecarSizes only? But encodeRgba8Pyramid expects sidecars + produces full.
  // For JPG ladder: encode the downscales from the decoded, using a modified plan that has no "full" intent, then append the transcoded as full.
  const smallPlan: PyramidEncodeOptions = {
    ...plan,
    // Only the grid sidecars; 2048 may be included if < master, but per spec for JPG the 2048 is also sidecar at q95 if applicable.
    // Simpler: run the full plan encode on the decoded (it will produce sidecars + a re-encode full), drop the last (re-encode), keep the transcoded.
  };
  const produced = await jxl.encodePyramid(decoded.rgba, decoded.width, decoded.height, smallPlan);
  // Drop the last (the re-encoded "full" from the sidecar call); the real full is the transcoded.
  const levels = produced.slice(0, -1);
  return { levels, fullTranscoded: transcodedFull };
}

/** Proxy: single level. */
export async function buildProxyLadder(
  jxl: JxlBackend,
  rgba: Uint8Array,
  width: number,
  height: number,
  plan: PyramidEncodeOptions,
): Promise<PyramidLevelBytes[]> {
  return jxl.encodePyramid(rgba, width, height, plan);
}
