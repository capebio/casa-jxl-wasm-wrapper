"""inject-dictionary.py — add glossary/dictionary panel to ecosystem-map.html"""
import sys
sys.stdout.reconfigure(encoding='utf-8')

with open('docs/ecosystem-map.html', encoding='utf-8') as f:
    html = f.read()

checks = []

def patch(old, new, label):
    global html
    assert old in html, f'Anchor not found: {label!r}'
    html = html.replace(old, new, 1)
    assert new in html, f'Replacement not applied: {label!r}'
    checks.append(label)

# ─────────────────────────────────────────────────────────────────────────────
# 1. Extend GLOSSARY + inject DICT_XREF constant after closing };
# ─────────────────────────────────────────────────────────────────────────────

GLOSS_OLD = '"modular":"libjxl\'s lossless / near-lossless mode (vs the VarDCT lossy mode).",\n};'

GLOSS_NEW = '''"modular":"libjxl's lossless / near-lossless mode (vs the VarDCT lossy mode).",
 "opfs":"Origin Private File System — a browser API for fast persistent file storage in a per-origin directory. No user prompt needed; only accessible to the same origin. Used here for tile caches.",
 "sab":"SharedArrayBuffer — a fixed-size binary buffer truly shared between the main thread and Web Workers; changes on one side are instantly visible on the other. Requires COOP + COEP headers.",
 "hwm":"High Water Mark — a threshold on a queue. When buffered bytes exceed the HWM the producer is paused (backpressure). When the queue drains below it the producer resumes.",
 "ema":"Exponential Moving Average — a running average that weights recent values more strongly than older ones. Used in decode-handler to track drain rates without storing a full history.",
 "lru":"Least Recently Used — a cache eviction policy: when full, discard the entry unused for the longest time.",
 "pgo":"Profile-Guided Optimisation — compile once to gather real-usage profiles then recompile using those profiles to guide inlining and branch layout. Used when building optimised libjxl.",
 "dng":"Digital Negative — Adobe's open documented raw image format; a TIFF variant with extra metadata tags. Some cameras output DNG natively; Lightroom/Photoshop can convert proprietary raws to DNG.",
 "cr2":"Canon Raw version 2 — Canon's proprietary raw format, a TIFF variant storing pixel data as lossless JPEG (LJPEG) and camera metadata in a vendor-private MakerNote EXIF blob.",
 "orf":"Olympus Raw Format — Olympus's TIFF-based raw format. White balance and colour matrices live in a MakerNote block (header: OLYMP or OM SYSTEM).",
 "fnv":"Fowler-Noll-Vo — a fast non-cryptographic hash. Used here in place of SHA-256 for content-addressed cache keys: ~100x faster; collision resistance is sufficient for local caching.",
 "sha":"Secure Hash Algorithm — a family of cryptographic hash functions (SHA-1, SHA-256…). Used for content-addressed cache keys but replaced by FNV for speed.",
 "cdp":"Chrome DevTools Protocol — the JSON/WebSocket API for remote control of Chrome. Used in benchmarking scripts to capture CPU flame graphs and measure paint timing.",
 "coop":"Cross-Origin Opener Policy — an HTTP header (same-origin) that opts a page into a stricter browsing-context group; required to unlock SharedArrayBuffer.",
 "coep":"Cross-Origin Embedder Policy — an HTTP header (require-corp) that blocks cross-origin resources that do not explicitly opt in; required alongside COOP to unlock SharedArrayBuffer.",
 "rgba":"Red Green Blue Alpha — a 4-channel pixel layout: three colour channels plus 8-bit opacity (alpha). The pipeline's native output (RGBA8 = 8-bit per channel; RGBA16 = 16-bit per channel).",
 "rgb":"Red Green Blue — the additive colour model used by displays. Three 8- or 16-bit channels per pixel with no transparency channel.",
 "dc":"In frequency-domain codecs: the zero-frequency (average brightness) coefficient of a block. A JXL DC frame is a tiny thumbnail from these averages alone — arrives very fast over a slow link.",
 "ac":"In frequency-domain codecs: all transform coefficients above the DC average — edges, texture and fine detail. AC data is the bulk of JXL and JPEG storage.",
 "dct":"Discrete Cosine Transform — decomposes an image block into spatial-frequency components. JXL's VarDCT lossy mode encodes only the significant DCT coefficients, like JPEG but with variable block sizes.",
 "vardct":"Variable-block-size DCT — libjxl's lossy encoding mode. Uses DCT blocks of varying sizes (2x2 to 64x64) chosen per region for maximum quality, versus the fixed 8x8 of classic JPEG.",
 "malloc":"Dynamic memory allocation from the C heap (libc malloc/free). In WASM the module owns a linear memory arena; any unreleased malloc causes the heap to grow permanently until the page reloads.",
 "backpressure":"Flow control: a fast producer is told to pause when a downstream consumer's buffer is full. The scheduler pauses workers when queued bytes exceed the High Water Mark then resumes when drained.",
 "preemption":"Interrupting a lower-priority in-flight decode so a higher-priority job can proceed. The scheduler hard-cancels an active decode between chunk boundaries and re-queues the cancelled job.",
 "dedup":"Deduplication — detecting that two requests refer to the same logical image and fulfilling both from one decode pass, saving CPU and bandwidth.",
 "codec":"Coder-decoder — software that compresses (encodes) and decompresses (decodes). JXL and the raw pipeline together form a RAW-to-JXL codec chain.",
 "worker":"A Web Worker — a JavaScript execution context running in parallel to the main thread, with its own event loop. Workers here own the JXL decoder state machine and WASM heap.",
 "transferable":"A browser object (typically ArrayBuffer) that can be moved — not copied — between threads via postMessage. After transfer the source buffer is detached (zero bytes) and cannot be reused.",
 "bilinear":"Interpolation using a weighted average of the 4 nearest same-colour neighbours. The simplest and fastest demosaic algorithm; slightly blurs colour edges compared to gradient-corrected methods.",
 "luma":"Perceived brightness — the Y component in YCbCr or XYB. Human vision is most sensitive to luma resolution so codecs allocate the most bits here.",
 "chroma":"Colour information (hue + saturation) separate from brightness. In YCbCr: Cb (blue-luma) and Cr (red-luma). Eyes tolerate lower chroma resolution so chroma is often subsampled.",
 "histogram":"A count of pixels at each brightness or colour level. Used for exposure analysis and in the fused frame-stats kernel that traverses RGBA8 in a single pass.",
 "wasm-pack":"A build tool that compiles a Rust crate to WebAssembly and generates JavaScript/TypeScript bindings, a package.json, and a pkg/ output directory ready for npm.",
 "emscripten":"A compiler toolchain (Clang/LLVM + Binaryen) that compiles C/C++ to WebAssembly. Used to build libjxl for the browser with the same optimisation flags as the native build.",
 "ipc":"Inter-Process Communication — data exchanged between separate OS processes. In Node the scheduler sends messages to worker child-processes over a built-in IPC channel.",
 "abi":"Application Binary Interface — the calling convention between compiled code units: register usage, stack layout, struct alignment. Rust and C must agree at every FFI boundary.",
};
const DICT_XREF={
 "cfa":{abbr:"CFA",full:"Colour Filter Array"},
 "mhc":{abbr:"MHC",full:"Malvar-He-Cutler"},
 "lut":{abbr:"LUT",full:"Look-Up Table"},
 "srgb":{abbr:"sRGB",full:"Standard Red Green Blue"},
 "eotf":{abbr:"EOTF",full:"Electro-Optical Transfer Function"},
 "iso":{abbr:"ISO",full:"International Organisation for Standardisation (sensor gain)"},
 "exif":{abbr:"EXIF",full:"Exchangeable Image File Format"},
 "ifd":{abbr:"IFD",full:"Image File Directory"},
 "tiff":{abbr:"TIFF",full:"Tagged Image File Format"},
 "ljpeg":{abbr:"LJPEG",full:"Lossless JPEG"},
 "jxl":{abbr:"JXL",full:"JPEG XL"},
 "jxtc":{abbr:"JXTC",full:"JXL Tile Container"},
 "ssim":{abbr:"SSIM",full:"Structural Similarity Index"},
 "psnr":{abbr:"PSNR",full:"Peak Signal-to-Noise Ratio"},
 "mse":{abbr:"MSE",full:"Mean Squared Error"},
 "simd":{abbr:"SIMD",full:"Single Instruction Multiple Data"},
 "avx2":{abbr:"AVX2",full:"Advanced Vector Extensions 2"},
 "avx-512":{abbr:"AVX-512",full:"Advanced Vector Extensions 512"},
 "fma":{abbr:"FMA",full:"Fused Multiply-Add"},
 "soa":{abbr:"SoA",full:"Structure of Arrays"},
 "xyb":{abbr:"XYB",full:"XYB Opponent Colour Space"},
 "ffi":{abbr:"FFI",full:"Foreign Function Interface"},
 "raii":{abbr:"RAII",full:"Resource Acquisition Is Initialisation"},
 "arc":{abbr:"Arc",full:"Atomic Reference Count"},
 "roi":{abbr:"ROI",full:"Region of Interest"},
 "opfs":{abbr:"OPFS",full:"Origin Private File System"},
 "sab":{abbr:"SAB",full:"SharedArrayBuffer"},
 "hwm":{abbr:"HWM",full:"High Water Mark"},
 "ema":{abbr:"EMA",full:"Exponential Moving Average"},
 "lru":{abbr:"LRU",full:"Least Recently Used"},
 "pgo":{abbr:"PGO",full:"Profile-Guided Optimisation"},
 "dng":{abbr:"DNG",full:"Digital Negative"},
 "cr2":{abbr:"CR2",full:"Canon Raw version 2"},
 "orf":{abbr:"ORF",full:"Olympus Raw Format"},
 "fnv":{abbr:"FNV",full:"Fowler-Noll-Vo"},
 "sha":{abbr:"SHA",full:"Secure Hash Algorithm"},
 "cdp":{abbr:"CDP",full:"Chrome DevTools Protocol"},
 "coop":{abbr:"COOP",full:"Cross-Origin Opener Policy"},
 "coep":{abbr:"COEP",full:"Cross-Origin Embedder Policy"},
 "rgba":{abbr:"RGBA",full:"Red Green Blue Alpha"},
 "rgb":{abbr:"RGB",full:"Red Green Blue"},
 "dc":{abbr:"DC",full:"Direct-Current component"},
 "ac":{abbr:"AC",full:"Alternating-Current components"},
 "dct":{abbr:"DCT",full:"Discrete Cosine Transform"},
 "vardct":{abbr:"VarDCT",full:"Variable-block DCT"},
 "ipc":{abbr:"IPC",full:"Inter-Process Communication"},
 "abi":{abbr:"ABI",full:"Application Binary Interface"},
 "wasm":{abbr:"WASM",full:"WebAssembly"},
 "wasm128":{abbr:"WASM128",full:"WebAssembly 128-bit SIMD"},
 "rggb":{abbr:"RGGB",full:"Red-Green-Green-Blue (Bayer order)"},
 "malloc":{abbr:"malloc",full:"memory allocation (C stdlib)"},
 "rgba":{abbr:"RGBA",full:"Red Green Blue Alpha"},
};'''

patch(GLOSS_OLD, GLOSS_NEW, 'GLOSSARY+DICT_XREF')

# ─────────────────────────────────────────────────────────────────────────────
# 2. Enhance showGloss to display full name for acronym entries
# ─────────────────────────────────────────────────────────────────────────────

OLD_SHOW = ('function showGloss(term,x,y){ const def=GLOSSARY[term]; if(!def) return;\n'
            '  glosspop.innerHTML=`<b>${term}</b><br>${def}`; glosspop.style.display="block";\n'
            '  const r=glosspop.getBoundingClientRect();\n'
            '  glosspop.style.left=Math.min(x,window.innerWidth-r.width-12)+"px";\n'
            '  glosspop.style.top=Math.min(y+14,window.innerHeight-r.height-12)+"px"; }')

NEW_SHOW = ('function showGloss(term,x,y){ const def=GLOSSARY[term]; if(!def) return;\n'
            '  const xr=DICT_XREF&&DICT_XREF[term];\n'
            '  const head=xr?`<b>${xr.abbr}</b> <span style="color:var(--dim)"> — ${xr.full}</span>`:`<b>${term}</b>`;\n'
            '  glosspop.innerHTML=head+\'<br>\'+def; glosspop.style.display="block";\n'
            '  const r=glosspop.getBoundingClientRect();\n'
            '  glosspop.style.left=Math.min(x,window.innerWidth-r.width-12)+"px";\n'
            '  glosspop.style.top=Math.min(y+14,window.innerHeight-r.height-12)+"px"; }')

patch(OLD_SHOW, NEW_SHOW, 'showGloss enhanced')

# ─────────────────────────────────────────────────────────────────────────────
# 3. go() — remove dict-mode when any node/edge is rendered
# ─────────────────────────────────────────────────────────────────────────────

OLD_GO = ('function go(renderFn,label){\n'
          '  if(!_navGuard && curView) navStack.push({render:curView.render,label:curView.label,cam:camSnap()});')

NEW_GO = ('function go(renderFn,label){\n'
          '  P.el.classList.remove("dict-mode");\n'
          '  if(!_navGuard && curView) navStack.push({render:curView.render,label:curView.label,cam:camSnap()});')

patch(OLD_GO, NEW_GO, 'go() dict-mode removal')

# ─────────────────────────────────────────────────────────────────────────────
# 4. deselect() — also remove dict-mode on panel close
# ─────────────────────────────────────────────────────────────────────────────

patch('P.el.classList.remove("open"); }',
      'P.el.classList.remove("open","dict-mode"); }',
      'deselect dict-mode removal')

# ─────────────────────────────────────────────────────────────────────────────
# 5. CSS — dictionary panel styles
# ─────────────────────────────────────────────────────────────────────────────

DICT_CSS = """  /* dictionary panel */
  #panel.dict-mode .kind,#panel.dict-mode h2,#panel.dict-mode .path,
  #panel.dict-mode p,#panel.dict-mode #pnote,#panel.dict-mode .flowbtn,
  #panel.dict-mode .sec,#panel.dict-mode .back{display:none!important}
  #dictcontent{display:none}
  #panel.dict-mode #dictcontent{display:block}
  .dict-header{display:flex;justify-content:space-between;align-items:baseline;
    margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid var(--line)}
  .dict-header span:first-child{font-size:15px;font-weight:600}
  .dict-count{font-size:11px;color:var(--dim)}
  .dict-search{width:100%;box-sizing:border-box;background:#1a2238;border:1px solid #2c3a5a;
    color:var(--ink);border-radius:6px;padding:6px 10px;font-size:13px;outline:none;
    display:block;margin-bottom:8px}
  .dict-search:focus{border-color:#3f7fb0}
  .dict-alpha{font-size:10px;font-weight:700;color:var(--dim);text-transform:uppercase;
    letter-spacing:.8px;padding:8px 0 3px;border-top:1px solid var(--line);margin-top:4px}
  .dict-alpha:first-child{border-top:none;margin-top:0;padding-top:2px}
  .dict-term{padding:4px 6px;border-radius:5px;cursor:pointer;font-size:12.5px;
    color:#c8d4e8;line-height:1.35;user-select:none}
  .dict-term:hover{background:#1a2c48;color:#e8f2ff}
  .dict-xref{color:#7a8aaa;font-style:italic}
  .dict-xref:hover{background:#162338;color:#a8bcd8}
"""

patch('</style>', DICT_CSS + '</style>', 'dict CSS')

# ─────────────────────────────────────────────────────────────────────────────
# 6. Toolbar — book button before cog (⚙)
# ─────────────────────────────────────────────────────────────────────────────

COG_BTN = '<button class="btn pointer" id="cog" title="Dev notes &amp; credits" style="margin-left:8px">&#9881;</button>'
DICT_BTN = '<button class="btn pointer" id="dictbtn" title="Glossary / dictionary" style="margin-left:4px">&#128218;</button>\n  ' + COG_BTN

# Try the literal HTML first, then fall back to what might be in the file
if COG_BTN in html:
    patch(COG_BTN, DICT_BTN, 'book button (entity form)')
else:
    COG_BTN2 = '<button class="btn pointer" id="cog" title="Dev notes & credits" style="margin-left:8px">⚙</button>'
    DICT_BTN2 = '<button class="btn pointer" id="dictbtn" title="Glossary / dictionary" style="margin-left:4px">📖</button>\n  ' + COG_BTN2
    patch(COG_BTN2, DICT_BTN2, 'book button (literal form)')

# ─────────────────────────────────────────────────────────────────────────────
# 7. Dictionary JS — build entries + openDict() — after glosspop click handler
# ─────────────────────────────────────────────────────────────────────────────

GLOSS_HANDLER_END = ('  else if(!(e.target.closest&&e.target.closest("#glosspop"))) glosspop.style.display="none";\n'
                     '});')

DICT_JS = """
/* ---- dictionary panel ---- */
function _buildDictEntries(){
  const ents=[];
  for(const [k,def] of Object.entries(GLOSSARY)){
    const xr=DICT_XREF[k];
    if(xr){
      // Abbreviation entry: "SIMD — Single Instruction Multiple Data"
      ents.push({label:xr.abbr+' — '+xr.full, key:k, sort:xr.abbr.toLowerCase(), isXref:false});
      // Full-name cross-ref: "Single Instruction Multiple Data (SIMD)"
      ents.push({label:xr.full+' ('+xr.abbr+')', key:k, sort:xr.full.toLowerCase(), isXref:true});
    } else {
      ents.push({label:k, key:k, sort:k.toLowerCase(), isXref:false});
    }
  }
  ents.sort((a,b)=>a.sort.localeCompare(b.sort));
  return ents;
}
const DICT_ENTRIES=_buildDictEntries();

function _renderDictList(q){
  const fq=(q||'').toLowerCase().trim();
  const items=fq
    ? DICT_ENTRIES.filter(e=>e.sort.includes(fq)||GLOSSARY[e.key].toLowerCase().includes(fq))
    : DICT_ENTRIES;
  if(!items.length) return '<div style="padding:12px;color:var(--dim);font-size:12px">no matches for \\"'+escapeHtml(q)+'\\"</div>';
  let h='', cur='';
  for(const e of items){
    const letter=e.label[0].toUpperCase();
    if(!fq&&letter!==cur){ cur=letter; h+='<div class="dict-alpha">'+letter+'</div>'; }
    const cls='dict-term'+(e.isXref?' dict-xref':'');
    h+='<div class="'+cls+'" data-key="'+e.key+'">'+escapeHtml(e.label)+'</div>';
  }
  return h;
}

function openDict(){
  P.el.classList.add('dict-mode');
  let dc=document.getElementById('dictcontent');
  if(!dc){
    dc=document.createElement('div');
    dc.id='dictcontent';
    dc.innerHTML=
      '<div class="dict-header"><span>&#128218; Glossary</span><span class="dict-count">'+DICT_ENTRIES.length+' entries</span></div>'+
      '<input id="dictsearch" class="dict-search" placeholder="search terms…" autocomplete="off">'+
      '<div id="dictlist"></div>';
    P.el.appendChild(dc);
    document.getElementById('dictsearch').addEventListener('input',function(){
      document.getElementById('dictlist').innerHTML=_renderDictList(this.value);
    });
    dc.addEventListener('click',function(e){
      const t=e.target.closest('.dict-term');
      if(t) showGloss(t.dataset.key,e.clientX,e.clientY);
    });
  }
  document.getElementById('dictlist').innerHTML=_renderDictList('');
  const s=document.getElementById('dictsearch'); if(s){s.value='';setTimeout(()=>s.focus(),50);}
  P.el.classList.add('open');
  P.el.scrollTop=0;
}
"""

patch(GLOSS_HANDLER_END, GLOSS_HANDLER_END + DICT_JS, 'dict JS functions')

# ─────────────────────────────────────────────────────────────────────────────
# 8. Wire dictbtn click handler — after cog handler
# ─────────────────────────────────────────────────────────────────────────────

COG_HANDLER = 'document.getElementById("cog").onclick=()=>modal.classList.add("show");'
patch(COG_HANDLER,
      COG_HANDLER + '\ndocument.getElementById("dictbtn").onclick=openDict;',
      'dictbtn handler')

# ─────────────────────────────────────────────────────────────────────────────
# Write + verify
# ─────────────────────────────────────────────────────────────────────────────

with open('docs/ecosystem-map.html', 'w', encoding='utf-8') as f:
    f.write(html)

print(f'Done. {len(html):,} bytes (+{len(html)-original_len:,}), {html.count(chr(10))+1} lines')
print(f'Patches applied ({len(checks)}):')
for c in checks:
    print(f'  OK: {c}')

spot_checks = [
    'DICT_XREF',
    'openDict',
    'dict-mode',
    'dict-term',
    'dict-alpha',
    'dict-search',
    'dictbtn',
    'DICT_ENTRIES',
    '_renderDictList',
    'xr.abbr',
    'OPFS',
    'SAB',
    'HWM',
    'EMA',
    'LRU',
    'malloc',
]
print('\nSpot checks:')
for c in spot_checks:
    ok = c in html
    print(f'  {"OK" if ok else "MISSING":7s} {c!r}')
