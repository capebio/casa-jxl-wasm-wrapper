import type { JxlBackend, PyramidEncodeOptions, PyramidLevelBytes, RawBackend } from "./backends.js";

/** Build the full 8-bit ladder for a RAW master (use the one encode call for the grid + 2048; full re-encode at q95). */
export async function buildRawLadder(
  jxl: JxlBackend,
  rgba: Uint8Array,
  width: number,
  height: number,
  plan: PyramidEncodeOptions,
): Promise<PyramidLevelBytes[]> {
  // RAW: decode once done upstream; here just encode the RGBA8 pyramid (grid + 2048 at higher q, full at q95).
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
