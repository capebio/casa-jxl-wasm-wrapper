// Photon-noise progressive encode. Lossy → quality() = Butteraugli.
// Agent clones this into .flipflop/tests/<name>.mjs and appends: import { createEncoder } from the
// jxl-wasm dist; an encodePhoton(input, iso) async helper wrapping
// encodeJxlVariant({progressive:true, photonNoiseIso:iso}); a butteraugli(a,b).
// corpus: bring-your-own = the 8 StandardMultifileTest rgba assets (flipflop --inputs).
export const photonNotes = 'baseline iso800; candidate = optimizer-proposed iso/effort/distance';
