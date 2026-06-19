"""inject-math-credits-casabio.py
Adds:
  - Math dictionary tab (∑) inside glossary panel
  - Contributors/Credits tab (★) with Jon Sneyers, Dr Berman, Dr Gwynne-Evans
  - Non-Riemannian + Bermanian glossary entries
  - Casabio icon (top-left corner, hover tooltip + DGE signature)
  - Tab CSS, math formula CSS
"""
import sys, base64
sys.stdout.reconfigure(encoding='utf-8')

# Read signature PNG
with open('c:/personal/DGE Signature new.png', 'rb') as f:
    SIG_B64 = 'data:image/png;base64,' + base64.b64encode(f.read()).decode('ascii')

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
# 1. Add non-Riemannian + Bermanian glossary entries
# ─────────────────────────────────────────────────────────────────────────────

OLD_ABI = (' "abi":"Application Binary Interface — the calling convention between compiled code units:'
           ' register usage, stack layout, struct alignment. Rust and C must agree at every FFI boundary.",\n};')

NEW_ABI = (' "abi":"Application Binary Interface — the calling convention between compiled code units:'
           ' register usage, stack layout, struct alignment. Rust and C must agree at every FFI boundary.",'
           '''
 "non-riemannian":"A metric space in which large distances are NOT the sum of small steps along the shortest path (the geodesic additivity property breaks). Bujack et al. (PNAS 2022) proved human colour perception is non-Riemannian: a physical spacing of ΔL=30 is perceived as only ~1.5× the sensation of ΔL=15, not 2×. Engineering consequence: ΔE2000 over-counts large within-object colour swings. The good news (Bujack 2025, CGF): geodesics of the true metric coincide with the Riemannian approximation, so a single concave 1-D damping function f applied to arc-length recovers true perceived distance. Planned for the magic-wand selector and diagnostic colour extraction in the Casabio lightbox.",
 "bujack2022":"Bujack R, Teti E, Miller J, Caffrey E, Turton T. \\"The non-Riemannian nature of perceptual color space\\". PNAS 119(18), 2022. Proved via a 2-alternative-forced-choice crowd study (320 triads, ≥250 judges each on the neutral grey axis) that perceived colour distance is strictly sub-additive along a geodesic, falsifying the century-old Riemannian assumption and invalidating ΔE2000 for large differences.",
 "bujack2025":"Bujack R, Stark M, Turton T, Miller J, Rogers D. \\"The Geometry of Color in the Light of a Non-Riemannian Space\\". Computer Graphics Forum 44(3), 2025. Derives purely geometric definitions of lightness, hue, saturation and the neutral axis from the perceptual metric alone. Key result (Theorem 1): geodesics of the true non-Riemannian metric and its induced Riemannian metric coincide, so the non-Riemannian behaviour collapses to a scalar damping function f applied to arc length.",
 "bermanian":"Bermanian Mathematics refers to the mathematical framework developed by Dr Mark N. Berman (Jerusalem Multidisciplinary College, formerly Oxford). His work on pro-isomorphic zeta functions of nilpotent groups and Lie rings (Israel Journal of Mathematics 2025; arXiv:2007.06439) provides a group-theoretic Dirichlet-series framework studied for future structural application in the colour-pipeline non-Riemannian implementation. The zeta function ζ_Γ̂(s) = Σ a_n̂(Γ) n^(-s) enumerates subgroups whose profinite completion is isomorphic to Γ.",
 "ciede2000":"CIEDE2000 (ΔE2000) — the current CIE recommended colour-difference formula. Accounts for lightness, chroma, and hue non-uniformities in CIELAB. Valid only for small perceptual differences; for large differences the non-Riemannian damping (Bujack 2022) must be layered on top.",
};''')

patch(OLD_ABI, NEW_ABI, 'glossary: non-riemannian + bermanian entries')

# Add DICT_XREF entries for new acronyms
OLD_XREF_END = ' "malloc":{abbr:"malloc",full:"memory allocation (C stdlib)"},\n};'
NEW_XREF_END = (' "malloc":{abbr:"malloc",full:"memory allocation (C stdlib)"},'
                '\n "ciede2000":{abbr:"CIEDE2000",full:"CIE Colour-Difference formula 2000"},\n};')
patch(OLD_XREF_END, NEW_XREF_END, 'DICT_XREF: CIEDE2000')

# ─────────────────────────────────────────────────────────────────────────────
# 2. CSS — tabs, math panel, Casabio icon + tooltip
# ─────────────────────────────────────────────────────────────────────────────

EXTRA_CSS = """  /* dict tabs */
  .dict-tabs{display:flex;gap:4px;align-items:center;margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid var(--line)}
  .dict-tab-btn{background:none;border:1px solid transparent;color:var(--dim);border-radius:6px;
    padding:3px 9px;cursor:pointer;font-size:15px;line-height:1;transition:background .15s}
  .dict-tab-btn:hover{background:#141e30;color:var(--ink)}
  .dict-tab-btn.active{background:#1a2c48;border-color:#2c4470;color:#fff}
  .dict-tab-label{font-size:10.5px;color:var(--dim);letter-spacing:.5px;text-transform:uppercase;margin-left:auto}
  /* math formulae */
  .math-entry{padding:10px 0;border-bottom:1px solid #1a2234}
  .math-entry:last-child{border-bottom:none}
  .math-name{font-size:11px;text-transform:uppercase;letter-spacing:.7px;color:var(--dim);margin-bottom:4px}
  .math-cat{font-size:9.5px;color:#3a5070;float:right;text-transform:uppercase;letter-spacing:.4px}
  .math-formula{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;color:#ffd76a;
    background:#0d1520;border:1px solid #1d2e48;border-radius:6px;padding:7px 10px;margin:5px 0;
    white-space:pre-wrap;line-height:1.5}
  .math-formula sub{font-size:.75em;vertical-align:sub}
  .math-formula sup{font-size:.75em;vertical-align:super}
  .math-desc{font-size:12px;color:#9aacbf;line-height:1.55;margin-top:4px}
  /* contributors */
  .contrib-card{padding:10px 0;border-bottom:1px solid #1a2234}
  .contrib-card:last-child{border-bottom:none}
  .contrib-name{font-size:14px;font-weight:600;color:#e8f0ff;margin-bottom:2px}
  .contrib-role{font-size:11px;color:var(--dim);margin-bottom:6px}
  .contrib-desc{font-size:12px;color:#9aacbf;line-height:1.55}
  .contrib-papers{margin-top:6px;font-size:11px;color:#5a7fa8;line-height:1.55;font-style:italic}
  /* Casabio icon */
  #casabio-wrap{position:fixed;z-index:7;top:6px;left:6px;display:flex;align-items:center}
  #casabio-icon{width:30px;height:30px;border-radius:6px;cursor:pointer;display:block;
    object-fit:contain;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);
    padding:2px;transition:border-color .15s}
  #casabio-icon:hover{border-color:rgba(255,255,255,0.3)}
  #casabio-fb{width:30px;height:30px;border-radius:6px;cursor:pointer;display:none;
    background:#0d2a12;border:1px solid #1e4a22;align-items:center;justify-content:center;
    font-size:18px;flex-shrink:0}
  #casabio-tip{position:fixed;z-index:30;top:44px;left:6px;width:310px;
    background:#0d1520;border:1px solid #2c4470;border-radius:12px;padding:14px 16px;
    font-size:12px;color:#c6cedd;line-height:1.65;display:none;pointer-events:auto;
    box-shadow:0 12px 40px rgba(0,0,0,.7)}
  #casabio-tip p{margin:0 0 10px}
  #casabio-tip .tip-sig{margin-top:12px;text-align:right;border-top:1px solid #1d2e48;padding-top:10px}
  #casabio-tip .tip-sig img{max-width:200px;filter:grayscale(1) brightness(1.2);opacity:.85}
"""

patch('  #dictbtn,#cog{font-size:22px;line-height:1;padding:2px 7px}\n',
      '  #dictbtn,#cog{font-size:22px;line-height:1;padding:2px 7px}\n' + EXTRA_CSS,
      'CSS: tabs + math + casabio')

# ─────────────────────────────────────────────────────────────────────────────
# 3. HTML — Casabio icon element (after <canvas id="map"></canvas>)
# ─────────────────────────────────────────────────────────────────────────────

CASABIO_HTML = """
<a id="casabio-wrap" href="https://casabio.org" target="_blank" rel="noopener" title="Casabio.org — citizen science biodiversity platform">
  <img id="casabio-icon" src="https://casabio.org/favicon.ico"
       onerror="this.style.display='none';document.getElementById('casabio-fb').style.display='flex'">
  <div id="casabio-fb">🌿</div>
</a>
<div id="casabio-tip">
  <p>Casabio is a citizen science project for which efficiently processing pictures is highly critical to the workflow. By contributing to this project you could be helping thousands of people improve their uploading and browsing experience in Casabio.</p>
  <p>Every speed increase reduces load times and/or encode times, every MB less means less data sent and stored. This translates into less energy and water consumed in data-centres around the world.</p>
  <p><strong style="color:#7fc87a">So please contribute. Let's get the leanest JPEG XL pipeline in the world!</strong></p>
  <div class="tip-sig"><img src="__SIG_DATA_URI__" alt="Dr David Gwynne-Evans"></div>
</div>""".replace('__SIG_DATA_URI__', SIG_B64)

patch('<canvas id="map"></canvas>\n<div id="heatplayer">',
      '<canvas id="map"></canvas>' + CASABIO_HTML + '\n<div id="heatplayer">',
      'HTML: casabio icon')

# ─────────────────────────────────────────────────────────────────────────────
# 4. JS — MATH_DICT + CONTRIBUTORS constants (after DICT_ENTRIES)
# ─────────────────────────────────────────────────────────────────────────────

MATH_AND_CREDITS_JS = r"""
/* ---- Math dictionary ---- */
const MATH_DICT=[
{cat:"Signal Processing",name:"MSE — Mean Squared Error",
 formula:"MSE = (1/N) · Σᵢ (aᵢ − bᵢ)²",
 desc:"Foundation of all image quality metrics. N = total pixel channels compared; a and b are the two images. MSE = 0 means identical."},
{cat:"Signal Processing",name:"PSNR — Peak Signal-to-Noise Ratio",
 formula:"PSNR = 10 · log₁₀(MAX² / MSE)",
 desc:"Quality in decibels. MAX = 255 (8-bit) or 65535 (16-bit). ∞ when identical; >40 dB is visually near-lossless for natural photographs. Simpler than Butteraugli but ignores spatial masking."},
{cat:"Signal Processing",name:"SSIM — Structural Similarity Index",
 formula:"SSIM(x,y) = [(2μₓμᵧ + C₁)(2σₓᵧ + C₂)]\n         / [(μₓ² + μᵧ² + C₁)(σₓ² + σᵧ² + C₂)]",
 desc:"μ = local mean, σ² = variance, σₓᵧ = cross-covariance. C₁, C₂ stabilise near-zero denominators. Score ∈ [0,1], 1 = identical. Captures luminance, contrast and structure separately."},
{cat:"Perceptual / Colour",name:"Butteraugli p-norm",
 formula:"Score = (Σᵢ εᵢᵖ / N)^(1/p),  p ≈ 3",
 desc:"Weights worst errors more than the average. With p=3, one bad pixel has 3× the influence of a median one. Used in libjxl to drive lossy quality; the distance target is this score."},
{cat:"Perceptual / Colour",name:"Non-Riemannian colour damping  (Bujack 2022)",
 formula:"D_perceived(A,C) < D(A,B) + D(B,C)",
 desc:"Strict sub-additivity even along the geodesic: a 2× physical colour change is perceived as only ~1.5× the sensation. The damping function f is concave and approximately logarithmic (a second-order Weber–Fechner law). ΔE2000 is valid only for small differences."},
{cat:"Perceptual / Colour",name:"Riemannian reprieve  (Bujack 2025)",
 formula:"D_true(A,B) = f(D_Riem(A,B))",
 desc:"Geodesics of the true non-Riemannian metric and its Riemannian approximation coincide (Theorem 1). The non-Riemannian behaviour lives entirely in a monotone scalar function f applied to arc-length. This collapses exotic geometry to a 1-D lookup table—implementable in a WASM hot loop."},
{cat:"Perceptual / Colour",name:"sRGB EOTF  (gamma linearisation)",
 formula:"Cₗᵢₙ = ((C + 0.055) / 1.055)^2.4   [C > 0.04045]\nCₗᵢₙ = C / 12.92             [C ≤ 0.04045]",
 desc:"Converts stored sRGB byte values to linear physical light before matrix multiplication, blending, and tone operations. The pipeline bakes this into the LUT so it costs zero per-pixel floating-point ops."},
{cat:"Perceptual / Colour",name:"Camera → sRGB colour matrix",
 formula:"[R, G, B]ₛᵣᴳᴮ = M₃₃ · [R, G, B]ᴄᴀᴍᴇᴣᴀ",
 desc:"Per-camera 3×3 matrix maps raw sensor RGB to sRGB. Coefficients are manufacturer-specific (stored in MakerNote or hardcoded per model). Applied after white-balance scaling and before tone curve."},
{cat:"Pipeline math",name:"Log-normalised heat intensity  (heatmap layer)",
 formula:"t = log(1 + x) / log(1 + xₘₐₓ)",
 desc:"Maps raw git-churn counts x to t ∈ [0,1] on a logarithmic scale. Early commits accumulate quickly; later ones taper. Used for the radial blast-ring intensity per node in the git heatmap overlay."},
{cat:"Pipeline math",name:"Heat blast radius",
 formula:"r = clamp(70 + 500·t,  8,  1400) × camera_scale",
 desc:"Screen-pixel radius of each node’s heat glow ring. Grows logarithmically with cumulative churn via t, then proportional to zoom level so the glow feels stable as you zoom."},
{cat:"Pipeline math",name:"EMA — Exponential Moving Average",
 formula:"EMAₙ = α·xₙ + (1−α)·EMAₙ₋₁",
 desc:"α ∈ (0,1) is the smoothing factor. High α tracks recent values quickly; low α gives a stable long-term average. Used in decode-handler to track byte drain rates without storing a full history buffer."},
{cat:"Hash",name:"FNV-1a  (32-bit)",
 formula:"hash₀  = 2166136261  (offset basis)\nhashₙ = (hashₙ₋₁ ⊕ byteₙ) × 16777619  mod 2³²",
 desc:"⊕ = XOR. Non-cryptographic: XOR then multiply by a large prime. Fast and well-distributed for short strings. ~100× faster than SHA-256; used here for content-addressed cache keys where collision resistance requirements are modest."},
{cat:"Hash",name:"Pro-isomorphic zeta function  (Berman)",
 formula:"ζ̂_Γ(s) = Σₙ₌₁⁾ â_n(Γ) · n^(-s)",
 desc:"Dirichlet generating series that enumerates all finite-index subgroups of a nilpotent group Γ whose profinite completion is isomorphic to Γ itself. Admits an Euler product over rational primes. Studied by Dr Mark N. Berman as a structural framework with potential future application to the non-Riemannian colour pipeline."},
];

/* ---- Contributors ---- */
const CONTRIBUTORS=[
{name:"Jon Sneyers",role:"Computer Scientist · Google Zurich · JPEG XL lead architect",
 desc:"Belgian computer scientist and the primary architect of JPEG XL (ISO/IEC 18181). Previously co-created FLIF (Free Lossless Image Format, 2015). At Google Zurich he co-designed the XYB psychovisual colour space and the Butteraugli perceptual distance metric (with Jyrki Alakuijala), and authored the VarDCT variable-block encoder and progressive decode system. The entire JXL pipeline in this project — libjxl, XYB, VarDCT, Butteraugli, progressive decode — stands on his work.",
 papers:"J. Sneyers & P. Wuille, “FLIF: Free Lossless Image Format based on MANIAC compression”, ICIP 2016.\nJ. Alakuijala, R. van Asseldonk, S. Boukortt, M. Bruse, I. Chistyakov, M. Georgiev, T. Obryk, K. Osz, E. Rhatushnyak, J. Sneyers, Z. Szabadka, L. Vandevenne, L. Versari, J. Wassenberg: “JPEG XL next-generation image compression architecture and coding tools”, SPIE 2019."},
{name:"Dr Mark N. Berman",role:"Mathematician · Jerusalem Multidisciplinary College (formerly Oxford)",
 desc:"Specialist in pro-isomorphic zeta functions of nilpotent groups and Lie rings. His mathematical framework — Bermanian Mathematics — models the structural growth of group lattices via Dirichlet series with Euler product decompositions over rational primes. Explored as a future structural tool for the non-Riemannian colour geometry implementation in this pipeline.",
 papers:"M.N. Berman, B. Klopsch & U. Onn, “On Pro-Isomorphic Zeta Functions of D*-Groups of Even Hirsch Length”, Israel Journal of Mathematics 269, 617–695, 2025. DOI: 10.1007/s11856-025-2822-2\nM.N. Berman, I. Glazer & M.M. Schein, “Pro-Isomorphic Zeta Functions of Nilpotent Groups and Lie Rings Under Base Extension”, arXiv:2007.06439 (2022)."},
{name:"Dr David Gwynne-Evans",role:"Botanist · Developer, Casabio.org",
 desc:"Botanist and developer of Casabio.org, a citizen science platform for biodiversity documentation. The ecological workflow requirements that shape this pipeline — efficient processing of field photographs under variable lighting, perceptual colour accuracy for species identification, offline-capable progressive decode for remote fieldwork, and extreme data efficiency for global reach — all originate here. His Hermannia monographs and fieldwork across the Karoo and Namibia provide real-world test cases for colour fidelity and compression performance.",
 papers:"Casabio.org — citizen science biodiversity platform, open to global contributors."},
];
"""

patch('const DICT_ENTRIES=_buildDictEntries();\n',
      'const DICT_ENTRIES=_buildDictEntries();\n' + MATH_AND_CREDITS_JS,
      'JS: MATH_DICT + CONTRIBUTORS')

# ─────────────────────────────────────────────────────────────────────────────
# 5. Replace openDict with tabbed version
# ─────────────────────────────────────────────────────────────────────────────

OLD_OPEN_DICT = (
    'function openDict(){\n'
    '  P.el.classList.add(\'dict-mode\');\n'
    '  let dc=document.getElementById(\'dictcontent\');\n'
    '  if(!dc){\n'
    '    dc=document.createElement(\'div\');\n'
    '    dc.id=\'dictcontent\';\n'
    '    dc.innerHTML=\n'
    '      \'<div class="dict-header"><span>&#128218; Glossary</span><span class="dict-count">\'+DICT_ENTRIES.length+\' entries</span></div>\'+\n'
    '      \'<input id="dictsearch" class="dict-search" placeholder="search terms…" autocomplete="off">\'+\n'
    '      \'<div id="dictlist"></div>\';\n'
    '    P.el.appendChild(dc);\n'
    '    document.getElementById(\'dictsearch\').addEventListener(\'input\',function(){\n'
    '      document.getElementById(\'dictlist\').innerHTML=_renderDictList(this.value);\n'
    '    });\n'
    '    dc.addEventListener(\'click\',function(e){\n'
    '      const t=e.target.closest(\'.dict-term\');\n'
    '      if(t){ e.stopPropagation(); showGloss(t.dataset.key,e.clientX,e.clientY); }\n'
    '    });\n'
    '  }\n'
    '  document.getElementById(\'dictlist\').innerHTML=_renderDictList(\'\');\n'
    '  const s=document.getElementById(\'dictsearch\'); if(s){s.value=\'\';setTimeout(()=>s.focus(),50);}\n'
    '  P.el.classList.add(\'open\');\n'
    '  P.el.scrollTop=0;\n'
    '}'
)

NEW_OPEN_DICT = r"""function _renderMath(){
  let h='';
  let curCat='';
  for(const e of MATH_DICT){
    if(e.cat!==curCat){
      curCat=e.cat;
      h+='<div class="dict-alpha">'+e.cat+'</div>';
    }
    h+='<div class="math-entry">'
      +'<div class="math-name">'+escapeHtml(e.name)+'</div>'
      +'<div class="math-formula">'+escapeHtml(e.formula)+'</div>'
      +'<div class="math-desc">'+escapeHtml(e.desc)+'</div>'
      +'</div>';
  }
  return h;
}
function _renderCredits(){
  let h='';
  for(const c of CONTRIBUTORS){
    h+='<div class="contrib-card">'
      +'<div class="contrib-name">'+escapeHtml(c.name)+'</div>'
      +'<div class="contrib-role">'+escapeHtml(c.role)+'</div>'
      +'<div class="contrib-desc">'+escapeHtml(c.desc)+'</div>'
      +'<div class="contrib-papers">'+escapeHtml(c.papers)+'</div>'
      +'</div>';
  }
  return h;
}
let _dictTab='terms';
function _switchDictTab(tab){
  _dictTab=tab;
  ['terms','math','credits'].forEach(t=>{
    const b=document.getElementById('dtab-'+t);
    if(b) b.classList.toggle('active',t===tab);
  });
  const search=document.getElementById('dictsearch');
  const list=document.getElementById('dictlist');
  const countEl=document.getElementById('dictcount');
  if(tab==='terms'){
    if(search) search.style.display='';
    if(countEl) countEl.textContent=DICT_ENTRIES.length+' entries';
    if(list){ list.innerHTML=_renderDictList(search?search.value:''); }
  } else if(tab==='math'){
    if(search) search.style.display='none';
    if(countEl) countEl.textContent=MATH_DICT.length+' formulae';
    if(list) list.innerHTML=_renderMath();
  } else {
    if(search) search.style.display='none';
    if(countEl) countEl.textContent=CONTRIBUTORS.length+' contributors';
    if(list) list.innerHTML=_renderCredits();
  }
  P.el.scrollTop=0;
}
function openDict(startTab){
  P.el.classList.add('dict-mode');
  let dc=document.getElementById('dictcontent');
  if(!dc){
    dc=document.createElement('div');
    dc.id='dictcontent';
    dc.innerHTML=
      '<div class="dict-tabs">'
        +'<button class="dict-tab-btn active" id="dtab-terms" title="Terms glossary">\u{1F4D6}</button>'
        +'<button class="dict-tab-btn" id="dtab-math" title="Mathematical formulae">∑</button>'
        +'<button class="dict-tab-btn" id="dtab-credits" title="Contributors">★</button>'
        +'<span class="dict-tab-label" id="dictcount">'+DICT_ENTRIES.length+' entries</span>'
      +'</div>'
      +'<input id="dictsearch" class="dict-search" placeholder="search terms…" autocomplete="off">'
      +'<div id="dictlist"></div>';
    P.el.appendChild(dc);
    document.getElementById('dictsearch').addEventListener('input',function(){
      document.getElementById('dictlist').innerHTML=_renderDictList(this.value);
    });
    ['terms','math','credits'].forEach(t=>{
      const b=document.getElementById('dtab-'+t);
      if(b) b.onclick=function(e){ e.stopPropagation(); _switchDictTab(t); };
    });
    dc.addEventListener('click',function(e){
      const t=e.target.closest('.dict-term');
      if(t){ e.stopPropagation(); showGloss(t.dataset.key,e.clientX,e.clientY); }
    });
  }
  _dictTab='terms';
  document.getElementById('dictlist').innerHTML=_renderDictList('');
  const s=document.getElementById('dictsearch');
  if(s){s.style.display='';s.value='';setTimeout(()=>s.focus(),50);}
  ['terms','math','credits'].forEach(t=>{
    const b=document.getElementById('dtab-'+t);
    if(b) b.classList.toggle('active',t==='terms');
  });
  const cnt=document.getElementById('dictcount');
  if(cnt) cnt.textContent=DICT_ENTRIES.length+' entries';
  if(startTab && startTab!=='terms') _switchDictTab(startTab);
  P.el.classList.add('open');
  P.el.scrollTop=0;
}"""

patch(OLD_OPEN_DICT, NEW_OPEN_DICT, 'openDict: tabbed version')

# ─────────────────────────────────────────────────────────────────────────────
# 6. Casabio tooltip JS — hover show/hide (after dictbtn handler)
# ─────────────────────────────────────────────────────────────────────────────

CASABIO_JS = """
/* ---- Casabio icon hover tooltip ---- */
(function(){
  const wrap=document.getElementById('casabio-wrap');
  const tip=document.getElementById('casabio-tip');
  if(!wrap||!tip) return;
  let _tipTimer=null;
  function showTip(){ clearTimeout(_tipTimer); tip.style.display='block'; }
  function hideTip(){ _tipTimer=setTimeout(()=>{ tip.style.display='none'; },200); }
  wrap.addEventListener('mouseenter', showTip);
  wrap.addEventListener('mouseleave', hideTip);
  tip.addEventListener('mouseenter', showTip);
  tip.addEventListener('mouseleave', hideTip);
  // Prevent icon click from opening dict; let the href handle it
  wrap.addEventListener('click', e=>e.stopPropagation());
}());
"""

patch('document.getElementById("dictbtn").onclick=openDict;\n',
      'document.getElementById("dictbtn").onclick=openDict;\n' + CASABIO_JS,
      'JS: casabio hover tooltip')

# ─────────────────────────────────────────────────────────────────────────────
# Write
# ─────────────────────────────────────────────────────────────────────────────

with open('docs/ecosystem-map.html', 'w', encoding='utf-8') as f:
    f.write(html)

print(f'Done. {len(html):,} bytes (+{len(html)-original_len:,}), {html.count(chr(10))+1} lines')
print(f'Patches ({len(checks)}):')
for c in checks: print(f'  OK: {c}')
