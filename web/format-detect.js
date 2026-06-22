// Classify an uploaded file into a decode route from its header bytes + name.
// Returns: 'raw' | 'jxl' | 'sdr' | 'tiff' | 'exr' | 'unknown'
//   raw  -> process_orf/dng/cr2     sdr -> createImageBitmap
//   tiff -> wasm decode_tiff        exr -> wasm decode_exr
//   jxl  -> existing jxl path
const RAW_EXT = /\.(orf|dng|cr2|raw|arw|nef|rw2)$/i;

export function detectFormat(bytes, name = '') {
  const b = bytes, n = name.toLowerCase();
  const m = (...s) => s.every((v, i) => b[i] === v);

  if (m(0x76, 0x2f, 0x31, 0x01)) return 'exr';                 // OpenEXR
  if (m(0xff, 0x0a) || n.endsWith('.jxl')) return 'jxl';       // JXL codestream
  if (m(0x00, 0x00, 0x00) && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70)
    return 'sdr';                                              // ISO-BMFF (avif/heic) -> browser
  if (m(0x89, 0x50, 0x4e, 0x47)) return 'sdr';                 // PNG
  if (m(0xff, 0xd8, 0xff)) return 'sdr';                       // JPEG
  if (m(0x47, 0x49, 0x46)) return 'sdr';                       // GIF
  if (m(0x52, 0x49, 0x46, 0x46) && b[8] === 0x57 && b[9] === 0x45
      && b[10] === 0x42 && b[11] === 0x50) return 'sdr';        // WEBP (RIFF…WEBP)
  if (m(0x49, 0x49, 0x2a, 0x00) || m(0x4d, 0x4d, 0x00, 0x2a)) {
    return RAW_EXT.test(n) ? 'raw' : 'tiff';                  // TIFF container
  }
  if (RAW_EXT.test(n)) return 'raw';
  return 'unknown';
}
