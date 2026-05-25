/**
 * Example: Using raw_converter_wasm functions from web/pkg/
 * 
 * Available functions:
 * - downscale_rgb(src, src_w, src_h, dst_w, dst_h): Uint8Array → downscaled RGB8
 * - rgb_to_rgba(rgb): Uint8Array → RGBA8 (adds alpha = 255)
 * - process_orf(data, ...): ProcessResult → metadata + RGB output
 * - apply_look(rgb16, ...): Uint8Array → re-toned RGBA8
 * - rotate_rgb8(src, w, h, turns): RotateResult → rotated RGB8
 */

import init, { downscale_rgb, rgb_to_rgba, process_orf } from './web/pkg/index.js';

async function initWasm() {
  await init();
  console.log('WASM initialized');
}

/**
 * Downscale an RGB8 image buffer
 */
function downscaleImage(
  rgbBuffer: Uint8Array,
  srcWidth: number,
  srcHeight: number,
  dstWidth: number,
  dstHeight: number
): Uint8Array {
  return downscale_rgb(rgbBuffer, srcWidth, srcHeight, dstWidth, dstHeight);
}

/**
 * Downscale and convert to RGBA (if alpha channel needed)
 */
function downscaleToRgba(
  rgbBuffer: Uint8Array,
  srcWidth: number,
  srcHeight: number,
  dstWidth: number,
  dstHeight: number
): Uint8Array {
  // Step 1: downscale RGB
  const downscaledRgb = downscale_rgb(
    rgbBuffer,
    srcWidth,
    srcHeight,
    dstWidth,
    dstHeight
  );

  // Step 2: convert to RGBA (adds alpha = 255)
  const rgba = rgb_to_rgba(downscaledRgb);

  return rgba;
}

/**
 * Example: process an ORF file and create a thumbnail
 */
async function processOrfWithThumbnail(
  orfData: Uint8Array,
  thumbnailWidth: number = 200,
  thumbnailHeight: number = 150
) {
  // Process the ORF file
  const result = process_orf(
    orfData,
    0, // exposure_ev
    0, // contrast
    0, // highlights
    0, // shadows
    0, // whites
    0, // blacks
    0, // saturation
    0, // vibrance
    0, // temp
    0, // tint
    NaN, // wb_r_override (use default)
    NaN, // wb_b_override (use default)
    0, // texture
    0  // clarity
  );

  // Get the full RGB buffer
  const fullRgb = result.rgb();
  const width = result.width;
  const height = result.height;

  // Create a thumbnail using downscale_rgb
  const thumbnail = downscale_rgb(
    fullRgb,
    width,
    height,
    thumbnailWidth,
    thumbnailHeight
  );

  // Convert to RGBA if needed for canvas display
  const thumbnailRgba = rgb_to_rgba(thumbnail);

  return {
    fullRgb,
    width,
    height,
    thumbnailRgba,
    thumbnailWidth,
    thumbnailHeight,
    metadata: {
      iso: result.iso,
      exposure: `${result.exposure_num}/${result.exposure_den}`,
      focal: `${result.focal_length_num}/${result.focal_length_den}mm`,
      make: result.make,
      model: result.model,
    },
  };
}

export { initWasm, downscaleImage, downscaleToRgba, processOrfWithThumbnail };
