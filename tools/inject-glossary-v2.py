"""inject-glossary-v2.py
1. Fix linkifyJargon — escape HTML AFTER matching, not before (fixes FFI in &quot;FFI&quot;)
2. Add 28 missing glossary terms
3. Add DICT_XREF entries for new acronyms
"""
import sys
sys.stdout.reconfigure(encoding='utf-8')

with open('docs/ecosystem-map.html', encoding='utf-8') as f:
    html = f.read()

original_len = len(html)
checks = []

def patch(old, new, label):
    global html
    cnt = html.count(old)
    assert cnt == 1, f'Anchor {label!r}: found {cnt}x (need exactly 1)'
    html = html.replace(old, new, 1)
    checks.append(label)

# ─────────────────────────────────────────────────────────────────────────────
# 1. Fix linkifyJargon — escape AFTER matching so &quot;FFI&quot; doesn't block match
# ─────────────────────────────────────────────────────────────────────────────

OLD_LINKIFY = ('function linkifyJargon(text){ return escapeHtml(text||"").replace(jrgRegex(),m=>{\n'
               '  const def=GLOSSARY[m.toLowerCase()]; return def?`<span class="jrg" data-t="${m.toLowerCase()}">${m}</span>`:m; }); }')

NEW_LINKIFY = r"""function linkifyJargon(text){
  // Match FIRST (on raw text), then escape each segment to avoid &quot; blocking lookbehind
  const t=text||''; const re=jrgRegex(); re.lastIndex=0;
  let out='',last=0,m;
  while((m=re.exec(t))!==null){
    const key=m[0].toLowerCase();
    if(GLOSSARY[key]){
      out+=escapeHtml(t.slice(last,m.index))+`<span class="jrg" data-t="${key}">${escapeHtml(m[0])}</span>`;
    } else {
      out+=escapeHtml(t.slice(last,m.index+m[0].length));
    }
    last=m.index+m[0].length;
  }
  return out+escapeHtml(t.slice(last));
}"""

patch(OLD_LINKIFY, NEW_LINKIFY, 'fix linkifyJargon (escape after match)')

# ─────────────────────────────────────────────────────────────────────────────
# 2. Add new GLOSSARY entries (after last entry, before closing };)
# ─────────────────────────────────────────────────────────────────────────────

OLD_GLOSS_END = (' "ciede2000":"CIEDE2000 (ΔE2000) — the current CIE recommended colour-difference formula.'
                 ' Accounts for lightness, chroma, and hue non-uniformities in CIELAB.'
                 ' Valid only for small perceptual differences; for large differences the'
                 ' non-Riemannian damping (Bujack 2022) must be layered on top.",\n};')

NEW_GLOSS_END = (' "ciede2000":"CIEDE2000 (ΔE2000) — the current CIE recommended colour-difference formula.'
                 ' Accounts for lightness, chroma, and hue non-uniformities in CIELAB.'
                 ' Valid only for small perceptual differences; for large differences the'
                 ' non-Riemannian damping (Bujack 2022) must be layered on top.",'
                 """
 "scalar":"A scalar code path processes one pixel (or one value) per CPU clock cycle, using ordinary arithmetic instructions. Contrasted with SIMD, which processes 4–16 values simultaneously using a single instruction. The scalar path is the correctness oracle — the SIMD path must produce bit-identical output on every input.",
 "seam":"An architectural seam is the boundary where two layers hand off data. Good seams are narrow (few message types), stable (rarely change), and testable in isolation. In this pipeline the key seams are: decoder → scheduler (JXL chunks), scheduler → decode-handler (push protocol), facade → WASM heap (zero-copy pointer), and decode-session → consumer (AsyncEventStream of frames).",
 "crate":"A crate is Rust's unit of compilation and distribution — roughly equivalent to a library or package in other languages. A binary crate produces an executable; a library crate produces linkable code. In this repo: crates/raw-pipeline is a library crate used by both the native binary and the WASM target.",
 "lod":"Level of Detail — the degree of geometric or visual resolution shown at a given zoom level. In the ecosystem map: at low zoom, only system-level nodes are expanded; at high zoom, individual functions become visible. The canvas renderer uses lod to decide which children to draw.",
 "perceptual":"Relating to how humans perceive a stimulus, as distinct from physical measurement. A perceptually uniform colour space has equal Euclidean distances between equally-perceived colour differences. Butteraugli and SSIM are perceptual metrics; MSE/PSNR are not — a pixel error invisible to humans may score poorly on MSE.",
 "tone":"Tone (or tone mapping) is the process of mapping linear light values captured by the sensor to display-ready values. This includes: black-level subtract, white-balance scaling, exposure compensation, the camera-to-sRGB colour matrix, a tone curve (shoulder + gamma), and saturation. The cost centre of the raw-pipeline.",
 "ingest":"The process of importing source files into the system, computing content hashes, building manifests, and writing sidecar JXL pyramid levels. In pyramid-ingest, ingest is a pipeline: hash → check-manifest → encode-levels → write-manifest. Ingest is write-once; subsequent reads use cached manifests.",
 "pyramid":"A multi-resolution image pyramid stores the same image at several quality/size levels (e.g. DC-only preview, thumbnail, full). Each level is a JXL file. The viewer requests the smallest level that satisfies the current viewport, then progressively upgrades as the user zooms in — avoiding full-resolution decode on small viewports.",
 "oracle":"A reference implementation used to verify correctness of an optimised variant. In this codebase the scalar path (process_into) is the oracle for the SIMD path (process_into_auto / apply_tone_bulk): on every test input, SIMD output must be bit-identical (or within 1 LSB for floating-point rounding) to the oracle.",
 "stride":"The number of bytes from the start of one row of pixels to the start of the next. Stride ≥ width × bytes_per_pixel; padding bytes may be added for alignment. Getting stride wrong causes diagonal shearing artefacts. In libjxl the stride is passed to JxlDecoderSetImageOutBuffer.",
 "heap":"The region of process memory used for dynamic allocation (malloc/new). Distinct from the stack (fixed-size, per-thread, automatically freed). WASM has a separate linear heap within its sandbox; the facade allocates image buffers there via js_alloc and the Rust global allocator.",
 "gather":"A SIMD gather instruction loads data from non-contiguous (scattered) memory addresses into a vector register. Used in the tone-map LUT step: each pixel's value is an index into the LUT, so the four indices point to four different LUT slots — a classic gather pattern. Gather has high latency (~20 cycles) compared to sequential SIMD loads (~1 cycle), making the LUT the pipeline bottleneck.",
 "linear":"Linear light: pixel values proportional to physical photon counts. Camera sensors capture linear light. Displays expect gamma-encoded (non-linear) values. All arithmetic (colour matrix, white balance, Butteraugli) must happen in linear light; the sRGB EOTF converts back to display-ready values at the end of the pipeline.",
 "kernel":"(1) A computation kernel is the inner loop of a data-parallel algorithm — the code applied identically to every element (pixel). (2) An OS kernel manages hardware resources. In this codebase always sense (1): apply_tone_math is the tone kernel; demosaic_rggb is the demosaic kernel.",
 "transcode":"Convert directly from one compressed format to another without full decoding to pixels. JPEG→JXL transcoding in bridge.cpp is lossless (bit-exact pixel recovery possible) because the JPEG DCT coefficients are preserved inside the JXL container instead of decompressing and re-compressing to pixels.",
 "photosite":"A single light-sensitive element on a camera sensor — the physical well that collects photons during exposure. Each photosite records ONE colour channel (red, green, or blue, depending on its Bayer filter). Demosaic reconstructs the missing two channels at every photosite from its neighbours.",
 "heatmap":"A colour overlay on the ecosystem map nodes showing git commit activity over time. Brighter/redder = more commits at that date. Controlled by the git heat player at the bottom of the screen.",
 "latency":"Time from submitting a request to receiving the first response. Contrasted with throughput (total data per second). For the progressive decode pipeline, latency is time-to-first-pixel (the DC frame); throughput is the sustained frame rate of subsequent refinement passes.",
 "throughput":"Total data processed per unit time. Contrasted with latency. The SIMD tone kernel improves throughput (more pixels/second); the progressive decoder trades some throughput to reduce latency (first frame appears earlier).",
 "dispatch":"At startup, check which SIMD instruction sets the current CPU supports (AVX2, AVX-512, etc.) and select the fastest available code path. The Rust is_x86_feature_detected! macro is the dispatch mechanism. Dispatch happens once; the chosen function pointer is cached.",
 "cbindgen":"A Rust tool that reads Rust source and generates a C header declaring all pub extern-C functions and types. Used by this codebase to create wrapper.h from the Rust encoder/decoder, so C++ (bridge.cpp) can call back into Rust.",
 "headless":"Running a browser (Chrome/Chromium) without any visible window. Used for testing the full WASM pipeline in a real browser environment — including SharedArrayBuffer, OPFS, and Web Workers — without a display server. CDP (Chrome DevTools Protocol) controls the headless browser.",
 "scheduler":"The jxl-scheduler component sits between the application session and the worker pool. It assigns decode/encode jobs to idle workers, enforces priority preemption (a new urgent job interrupts a lower-priority one), deduplicates identical requests, and applies backpressure when the consumer is slow.",
 "encoder":"Software that compresses raw data into a smaller, encoded form. In this pipeline: the JXL encoder (jxl_casaencoder.rs) takes pixel buffers and produces JXL codestream bytes by driving libjxl's encode sequence.",
 "decoder":"Software that decompresses an encoded stream back to raw data. In this pipeline: the JXL decoder (jxl_casadecoder.rs) takes JXL codestream bytes and returns pixel buffers. Also: the RAW decoder (process_orf/process_dng/process_cr2) converts camera RAW files into linear RGB pixels.",
 "hud":"Heads-Up Display — on-screen status overlays (zoom level, component count, breadcrumb trail, heat date) rendered on top of the canvas. In aviation, a HUD projects flight data onto the cockpit windshield so the pilot sees both data and world simultaneously.",
 "blacklevel":"The minimum raw sensor output — the ADC reading when no light hits the photosite (sensor dark current + read noise floor). Must be subtracted before applying the colour matrix or white balance, otherwise shadow detail is grey instead of black. Stored in EXIF/MakerNote per-frame.",
 "whitelevel":"The ADC saturation point — the raw value at which a photosite is fully saturated (clipped). Used to normalise the range [black_level, white_level] → [0, 1] before further processing. Clipped values cannot be recovered without highlight reconstruction.",
 "convolution":"A sliding-window operation that replaces each pixel with a weighted sum of its neighbours. The MHC demosaic uses 5×5 separable convolutions. Bilinear demosaic is a simpler 2×2 average (also a convolution). Convolutions are memory-bandwidth-bound at this scale.",
 "quantize":"Map a continuous or high-precision value to one of a finite number of discrete levels. Lossy JPEG XL uses quantization as its primary compression mechanism: DCT coefficients are divided by a quality-dependent step size and rounded to integers, discarding fine detail that the human eye cannot easily detect.",
 "heuristic":"A rule of thumb that works well in practice but is not guaranteed to be optimal. In this pipeline: the adaptive HWM (high-water-mark) backpressure threshold is a heuristic; the LRU (least recently used) eviction policy is a heuristic; effort=3 as the default encode quality/speed trade-off is a heuristic validated by benchmark.",
 "amortise":"Spread a one-time cost over many operations so the per-operation overhead becomes negligible. The decoder pool amortises JxlDecoder construction (typically 10–50ms) over many images. WASM module instantiation is amortised across the worker lifetime.",
};""")

patch(OLD_GLOSS_END, NEW_GLOSS_END, 'GLOSSARY: 28 new entries')

# ─────────────────────────────────────────────────────────────────────────────
# 3. Add DICT_XREF entries for new acronyms
# ─────────────────────────────────────────────────────────────────────────────

OLD_XREF_END = ' "ciede2000":{abbr:"CIEDE2000",full:"CIE Colour-Difference formula 2000"},\n};'
NEW_XREF_END = (' "ciede2000":{abbr:"CIEDE2000",full:"CIE Colour-Difference formula 2000"},'
                '\n "lod":{abbr:"LOD",full:"Level of Detail"},'
                '\n "hud":{abbr:"HUD",full:"Heads-Up Display"},'
                '\n "blacklevel":{abbr:"Black Level",full:"sensor dark current floor"},'
                '\n "whitelevel":{abbr:"White Level",full:"sensor saturation point"},'
                '\n};')

patch(OLD_XREF_END, NEW_XREF_END, 'DICT_XREF: lod/hud/blacklevel/whitelevel')

# ─────────────────────────────────────────────────────────────────────────────
# Write
# ─────────────────────────────────────────────────────────────────────────────
with open('docs/ecosystem-map.html', 'w', encoding='utf-8') as f:
    f.write(html)

print(f'Done. {len(html):,} bytes (+{len(html)-original_len:,}), {html.count(chr(10))+1} lines')
for c in checks:
    print(f'  OK: {c}')
