"""Inject git heat-map layer + time player into ecosystem-map.html"""
import sys, json, re
sys.stdout.reconfigure(encoding='utf-8')

with open('docs/ecosystem-map.html', encoding='utf-8') as f:
    html = f.read()

with open('docs/git-heatmap-data.json', encoding='utf-8') as f:
    heatmap_json = f.read()

# ─────────────────────────────────────────────────────────────────────────────
# 1. CSS  — insert before </style>
# ─────────────────────────────────────────────────────────────────────────────
CSS = """  /* git heat player */
  #heatplayer{position:fixed;z-index:8;bottom:0;left:50%;transform:translateX(-50%);
    background:var(--panel);border:1px solid var(--line);border-bottom:none;
    border-radius:10px 10px 0 0;padding:8px 14px 10px;display:flex;gap:8px;
    align-items:center;pointer-events:auto;backdrop-filter:blur(6px)}
  .hpbtn{background:#15203a;border:1px solid #243150;color:var(--ink);padding:4px 9px;
    border-radius:6px;cursor:pointer;font-size:13px;line-height:1;user-select:none}
  .hpbtn:hover{background:#1b294a;border-color:#3a4d7d}
  .hpbtn:active{transform:scale(.93)}
  #hp-slider{width:190px;accent-color:#e06040;cursor:pointer;vertical-align:middle}
  #hp-date{font-size:11.5px;color:#e09870;font-variant-numeric:tabular-nums;
    min-width:78px;text-align:center;font-family:ui-monospace,Menlo,Consolas,monospace}
  #hp-label{font-size:10px;color:var(--dim);letter-spacing:.5px;text-transform:uppercase;white-space:nowrap}
  .hp-dot{width:8px;height:8px;border-radius:50%;flex:none;
    background:radial-gradient(circle,#fff 10%,#ff0 40%,#f60 70%,#900 100%)}
"""
assert '</style>' in html, 'Could not find </style>'
html = html.replace('</style>', CSS + '</style>', 1)

# ─────────────────────────────────────────────────────────────────────────────
# 2. HTML player div — after <canvas id="map"></canvas>
# ─────────────────────────────────────────────────────────────────────────────
PLAYER_DIV = """
<div id="heatplayer">
  <span class="hp-dot"></span>
  <span id="hp-label">git heat</span>
  <button class="hpbtn" id="hp-rewind" title="Rewind to first date">&#9194;</button>
  <button class="hpbtn" id="hp-back" title="Step back one day">&#9664;</button>
  <button class="hpbtn" id="hp-play" title="Play / Pause">&#9654;</button>
  <button class="hpbtn" id="hp-fwd" title="Step forward one day">&#9654;&#9654;</button>
  <input type="range" id="hp-slider" min="0" max="35" value="35">
  <span id="hp-date">2026-06-19</span>
</div>"""
assert '<canvas id="map"></canvas>' in html
html = html.replace('<canvas id="map"></canvas>', '<canvas id="map"></canvas>' + PLAYER_DIV, 1)

# ─────────────────────────────────────────────────────────────────────────────
# 3. HEATMAP_DATA constant — after GRAPH-END marker
# ─────────────────────────────────────────────────────────────────────────────
GRAPH_END = '// <<ECOSYSTEM-GRAPH-END>>'
assert GRAPH_END in html
html = html.replace(
    GRAPH_END,
    GRAPH_END + '\n\nconst HEATMAP_DATA=' + heatmap_json + ';\n',
    1
)

# ─────────────────────────────────────────────────────────────────────────────
# 4. Heat state + drawHeat() + _updateHeatUI() — after root packing block
# ─────────────────────────────────────────────────────────────────────────────
ROOT_PACK = '{ // root packing\n  const root={children:ROOTS}; layout(root, WORLD.x,WORLD.y,WORLD.w,WORLD.h, -1);\n}'
assert ROOT_PACK in html, f'Could not find root packing block'

HEAT_CODE = """
/* ============================================================================
   Git Heat Map — radial glow layer rendered below all nodes
   Shows cumulative git-churn per tracked file as white-hot blast rings.
   Intensity  = log(cumulative churn) / log(global max)  → 0..1
   Radius     = (70 + 500·t) world units scaled to screen
   Colour     = white-hot core → yellow → orange → red → transparent
   ========================================================================== */
let heatIdx = HEATMAP_DATA.dates.length - 1;
let heatPlaying = false;
let heatLastMs = 0;
const HEAT_STEP_MS = 700; // ms per day when auto-playing

// Precompute log of max total churn (normalization denominator)
const HEAT_LOG_MAX = (function(){
  let mx = 1;
  for(const m of Object.values(HEATMAP_DATA.nodes)){
    let s = 0; for(const v of Object.values(m)) s += v;
    if(s > mx) mx = s;
  }
  return Math.log1p(mx);
}());

function drawHeat(now){
  // Advance frame if playing
  if(heatPlaying){
    if(now - heatLastMs > HEAT_STEP_MS){
      heatIdx++;
      if(heatIdx >= HEATMAP_DATA.dates.length){ heatIdx = HEATMAP_DATA.dates.length - 1; heatPlaying = false; }
      heatLastMs = now;
      _updateHeatUI();
    }
  }
  const cutoff = HEATMAP_DATA.dates[heatIdx];
  ctx.save();
  ctx.globalCompositeOperation = 'screen'; // additive glow on dark background
  for(const [nid, dm] of Object.entries(HEATMAP_DATA.nodes)){
    const node = N.get(nid);
    if(!node || !node.rect) continue;
    // Cumulate churn from all dates <= cutoff (log scale accumulates fast then tapers)
    let cum = 0;
    for(const [d, v] of Object.entries(dm)){ if(d <= cutoff) cum += v; }
    if(!cum) continue;
    const wx = node.rect.x + node.rect.w * 0.5;
    const wy = node.rect.y + node.rect.h * 0.5;
    const [sx, sy] = w2s(wx, wy);
    if(sx < -1600 || sx > W + 1600 || sy < -1600 || sy > H + 1600) continue;
    const t = Math.log1p(cum) / HEAT_LOG_MAX; // 0..1 log-normalised intensity
    // Blast radius grows logarithmically: fast at first, then tapers
    const r = Math.max(8, Math.min(1400, (70 + 500 * t) * cam.scale));
    // White component only appears at high intensity (>50%)
    const t2 = Math.max(0, t * 2 - 1);
    const g = ctx.createRadialGradient(sx, sy, 0, sx, sy, r);
    g.addColorStop(0,    'rgba(255,255,' + (255 * t2 | 0) + ',' + (0.62 + 0.32 * t2).toFixed(2) + ')');
    g.addColorStop(0.14, 'rgba(255,' + (175 + 80 * t | 0) + ',0,' + (0.58 * t).toFixed(2) + ')');
    g.addColorStop(0.40, 'rgba(255,' + (50 + 90 * t | 0) + ',0,' + (0.46 * t).toFixed(2) + ')');
    g.addColorStop(0.68, 'rgba(' + (160 + 90 * t | 0) + ',12,0,' + (0.26 * t).toFixed(2) + ')');
    g.addColorStop(1,    'rgba(110,0,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(sx, sy, r, 0, 6.2832); ctx.fill();
  }
  ctx.restore();
}

function _updateHeatUI(){
  const d = document.getElementById('hp-date');
  const s = document.getElementById('hp-slider');
  const p = document.getElementById('hp-play');
  if(d) d.textContent = HEATMAP_DATA.dates[heatIdx];
  if(s) s.value = heatIdx;
  if(p) p.innerHTML = heatPlaying ? '&#9646;&#9646;' : '&#9654;';
}
"""
html = html.replace(ROOT_PACK, ROOT_PACK + '\n' + HEAT_CODE, 1)

# ─────────────────────────────────────────────────────────────────────────────
# 5. Call drawHeat() in draw() — after background fill, before drawBoxes
# ─────────────────────────────────────────────────────────────────────────────
DRAW_ANCHOR = '    ctx.fillStyle=g; ctx.fillRect(0,0,W,H);\n    rendered=[];'
assert DRAW_ANCHOR in html, 'Could not find draw() anchor'
html = html.replace(
    DRAW_ANCHOR,
    '    ctx.fillStyle=g; ctx.fillRect(0,0,W,H);\n    drawHeat(performance.now());\n    rendered=[];',
    1
)

# ─────────────────────────────────────────────────────────────────────────────
# 6. Event handlers — before fit(); draw();
# ─────────────────────────────────────────────────────────────────────────────
FIT_DRAW = 'fit(); draw();'
assert FIT_DRAW in html

HANDLERS = """/* ---- heat player controls ---- */
(function(){
  const sl = document.getElementById('hp-slider');
  const max = HEATMAP_DATA.dates.length - 1;
  sl.max = max; sl.value = heatIdx;
  document.getElementById('hp-rewind').onclick = function(){
    heatIdx = 0; heatPlaying = false; _updateHeatUI();
  };
  document.getElementById('hp-back').onclick = function(){
    heatIdx = Math.max(0, heatIdx - 1); heatPlaying = false; _updateHeatUI();
  };
  document.getElementById('hp-play').onclick = function(){
    if(!heatPlaying && heatIdx >= HEATMAP_DATA.dates.length - 1) heatIdx = 0;
    heatPlaying = !heatPlaying;
    heatLastMs = performance.now();
    _updateHeatUI();
  };
  document.getElementById('hp-fwd').onclick = function(){
    heatIdx = Math.min(max, heatIdx + 1); heatPlaying = false; _updateHeatUI();
  };
  sl.oninput = function(){ heatIdx = +sl.value; heatPlaying = false; _updateHeatUI(); };
  _updateHeatUI();
}());

"""
html = html.replace(FIT_DRAW, HANDLERS + FIT_DRAW, 1)

# ─────────────────────────────────────────────────────────────────────────────
# Write output
# ─────────────────────────────────────────────────────────────────────────────
with open('docs/ecosystem-map.html', 'w', encoding='utf-8') as f:
    f.write(html)

print(f'Done. Output size: {len(html):,} bytes, {html.count(chr(10))+1} lines')

# Quick sanity checks
checks = [
    'HEATMAP_DATA=',
    'drawHeat(performance.now())',
    'heatplayer',
    'hp-play',
    'HEAT_LOG_MAX',
    '_updateHeatUI',
    'hp-rewind',
]
for c in checks:
    count = html.count(c)
    status = 'OK' if count >= 1 else 'MISSING'
    print(f'  {status}: {c!r} ({count}x)')
