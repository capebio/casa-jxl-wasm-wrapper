"""
Comprehensive patch: applies Rounds 8-12 to ecosystem-map.html
- Round 8/10: HUD restore, refresh btn, connectors toggle, egg-timer, ticker, zoomlbl
- Round 9: math dict copy/link/expand
- Round 11: walkthrough overlay, snake font fixes
- Round 12: Game Hub + Pixel Surgeon (fractal Canvas game)
"""
import pathlib, sys, re

HTML = pathlib.Path("docs/ecosystem-map.html")
html = HTML.read_text(encoding="utf-8")

# ─────────────────────────────────────────────────────────────────────────────
# STEP 1 — Insert missing UI HTML elements before <a id="casabio-wrap">
# ─────────────────────────────────────────────────────────────────────────────
ANCHOR = '<a id="casabio-wrap"'
assert ANCHOR in html, "casabio-wrap anchor not found"

UI_HTML = """\
<div id="heatplayer">
  <button class="hpbtn" id="hp-toggle" title="Toggle heat map on/off" style="font-size:11px;padding:4px 8px">\U0001f525 on</button>
  <span id="hp-label">git heat</span>
  <button class="hpbtn" id="hp-rewind" title="Rewind to first date">&#9194;</button>
  <button class="hpbtn" id="hp-back" title="Step back one day">&#9664;</button>
  <button class="hpbtn" id="hp-play" title="Play / Pause">&#9654;</button>
  <button class="hpbtn" id="hp-fwd" title="Step forward one day">&#9654;&#9654;</button>
  <input type="range" id="hp-slider" min="0" max="35" value="35">
  <span id="hp-date">2026-06-20</span>
</div>

<div id="top" class="hud">
  <h1 style="margin-left:50px">raw-pipeline <small>codec ecosystem · semantic-zoom map</small></h1>
  <input id="search" class="pointer" placeholder="find…" autocomplete="off">
  <button class="btn pointer" id="reset">⤢ Fit</button>
  <button class="btn pointer" id="flowtoggle">▶ Flow mode</button>
  <span class="chip" style="gap:6px;padding:4px 8px">
    <span style="color:var(--dim);font-size:10px;letter-spacing:.3px">flow</span>
    <label style="cursor:pointer;font-size:12px;color:var(--ink);display:flex;align-items:center;gap:3px"><input type="checkbox" id="showconn" checked> lines</label>
    <label style="cursor:pointer;font-size:12px;color:var(--ink);display:flex;align-items:center;gap:3px"><input type="checkbox" id="showlbl"> labels</label>
  </span>
  <span class="chip" style="gap:5px;margin-left:4px"><span style="color:var(--dim);font-size:11px">tech</span>
    <button class="btn pointer techbtn on" id="techRust">Rust</button>
    <button class="btn pointer techbtn on" id="techWasm">WASM</button>
    <button class="btn pointer techbtn on" id="techJs">JS</button></span>
  <button class="btn pointer" id="seamtoggle">◆ Seams</button>
  <span id="zoomlbl" style="font-size:12px;font-variant-numeric:tabular-nums;color:var(--dim);min-width:40px;text-align:right"></span>
  <span style="flex:1"></span>
  <button class="btn pointer" id="snakebtn" title="Pipeline timing" style="font-size:18px;padding:4px 8px">\U0001f40d</button>
  <button class="btn pointer" id="dictbtn" title="Glossary / dictionary" style="margin-left:4px">\U0001f4d6</button>
  <button class="btn pointer" id="cog" title="Dev notes &amp; credits" style="margin-left:4px">⚙</button>
  <button class="btn pointer" id="refreshbtn" title="Refresh / pull latest status" style="margin-left:4px;font-size:22px;padding:4px 10px;line-height:1">\U0001f504</button>
  <button class="btn pointer" id="gamebtn" title="Games — learn &amp; test your knowledge" style="margin-left:4px;font-size:16px">\U0001f3ae</button>
</div>
<div id="crumbs" class="hud"></div>

<aside id="panel">
  <span class="back" id="pback" title="Back to where you were">‹</span>
  <span class="close" id="pclose">\xd7</span>
  <div class="kind" id="pkind"></div>
  <h2 id="ptitle"></h2>
  <div class="path" id="ppath"></div>
  <p id="pdesc"></p>
  <div id="pnote"></div>
  <button class="btn flowbtn" id="ptrace">⇣ Trace data flow from here</button>
  <div class="sec" id="pout"></div>
  <div class="sec" id="pin"></div>
</aside>

<div id="legendwrap">
  <div id="legendinner">
    <div id="symslegend">
      <h4>node types <span style="color:var(--dim);font-weight:400;font-size:10px">· click to isolate</span></h4>
      <div class="lg" data-kind="system"><span class="sym sm">⊕</span><span>system</span></div>
      <div class="lg" data-kind="fn"><span class="sym">λ</span><span>algorithm / fn</span></div>
      <div class="lg" data-kind="module"><span class="sym">≡</span><span>module</span></div>
      <div class="lg" data-kind="component"><span class="sym">◈</span><span>component</span></div>
      <div class="lg sep" style="color:var(--dim);font-size:10px;letter-spacing:.4px;text-transform:uppercase">files</div>
      <div class="lg" data-kind="file"><span class="sym">⚙</span><span>.rs — Rust</span></div>
      <div class="lg" data-kind="file"><span class="sym">∥</span><span>.rs simd / arch</span></div>
      <div class="lg" data-kind="file"><span class="sym">Δ</span><span>.ts — TypeScript</span></div>
      <div class="lg" data-kind="file"><span class="sym">◎</span><span>.js / .mjs</span></div>
      <div class="lg" data-kind="file"><span class="sym">⊞</span><span>.cpp — C++</span></div>
      <div class="lg" data-kind="file"><span class="sym">⊤</span><span>.h — header</span></div>
    </div>
    <div id="legend">
      <h4>data payloads</h4>
      <div id="legitems"></div>
    </div>
  </div>
  <div id="legdock" title="Toggle legend panel">◄</div>
</div>

<div id="snakepanel">
  <div id="snake-bar">
    <span class="snake-title">\U0001f40d Pipeline timing</span>
    <button class="sbtn active" id="snake-log">linear scale</button>
    <select id="snake-mp" title="Megapixel target">
      <option value="6">6 MP</option>
      <option value="12" selected>12 MP</option>
      <option value="24">24 MP</option>
      <option value="48">48 MP</option>
    </select>
    <button class="sbtn" id="snake-anim">▶ animate</button>
    <div class="snake-legend">
      <div id="snake-legend-wrap"></div>
    </div>
    <button id="snake-close">\xd7</button>
  </div>
  <div id="snake-svg-wrap">
    <svg id="snake-svg"></svg>
  </div>
</div>

<div id="leaderboard">
  <div id="lb-row1">
    <span class="lb-field-label">zoom</span><span id="lb-zval">1\xd7</span>
  </div>
  <div class="lb-divider"></div>
  <div id="lb-tiers"></div>
</div>

<div id="probepopup"></div>
<div class="mem-tooltip" id="mem-tooltip"></div>

"""

html = html.replace(ANCHOR, UI_HTML + ANCHOR, 1)
print("Step 1: UI HTML inserted")

# ─────────────────────────────────────────────────────────────────────────────
# STEP 2 — CSS patches
# ─────────────────────────────────────────────────────────────────────────────

# 2a. zoomlbl CSS (was margin-left:auto, change to no margin)
html = html.replace(
    '#zoomlbl{margin-left:auto;color:var(--dim);font-variant-numeric:tabular-nums}',
    '#zoomlbl{color:var(--dim);font-variant-numeric:tabular-nums;font-size:12px}'
)

# 2b. heatplayer — remove transform so it abuts properly
html = html.replace(
    '#heatplayer{position:fixed;z-index:8;bottom:0;left:50%;transform:translateX(-50%);',
    '#heatplayer{position:fixed;z-index:8;bottom:0;left:50%;'
)

# 2c. math copy btn + src row CSS (inject before closing </style>)
MATH_CSS = """\
  .math-copy-btn{position:absolute;top:5px;right:6px;background:#15203a;border:1px solid #2c3a5a;
    color:#9aacbf;border-radius:4px;padding:2px 6px;font-size:10px;cursor:pointer;line-height:1.4}
  .math-copy-btn:hover{border-color:#4ea1d3;color:#e0f0ff}
  .math-src-row{margin-top:5px;font-size:10px}
  .math-src-link{color:#4ea1d3;text-decoration:none;border-bottom:1px dotted rgba(78,161,211,.4)}
  .math-src-link:hover{color:#9dd4f4}
"""

# Walkthrough CSS
WT_CSS = """\
  #wt-overlay{position:fixed;inset:0;z-index:9000;pointer-events:all;display:none}
  #wt-overlay.show{display:block}
  #wt-bg{position:absolute;inset:0;background:rgba(0,0,0,.72)}
  #wt-spotlight{position:absolute;border-radius:10px;box-shadow:0 0 0 9999px rgba(0,0,0,.72),0 0 0 3px #4ea1d3;
    transition:all .35s cubic-bezier(.4,0,.2,1);pointer-events:none}
  #wt-card{position:absolute;background:#0d1b30;border:1px solid #2a4a7a;border-radius:12px;
    padding:20px 22px;width:300px;box-shadow:0 8px 32px rgba(0,0,0,.6);z-index:1}
  #wt-icon{font-size:32px;margin-bottom:8px}
  #wt-title{margin:0 0 6px;font-size:16px;color:#e0f0ff;font-weight:700}
  #wt-body{margin:0 0 14px;font-size:13px;color:#9aacbf;line-height:1.55}
  #wt-step-indicator{display:flex;gap:5px;margin-bottom:10px}
  .wt-dot{width:7px;height:7px;border-radius:50%;background:#1a3a6a;transition:background .2s}
  .wt-dot.active{background:#4ea1d3}
  #wt-actions{display:flex;align-items:center;gap:8px}
  #wt-skip{background:none;border:none;color:#4a6a8a;font-size:12px;cursor:pointer;padding:0}
  #wt-skip:hover{color:#9aacbf}
  #wt-prev,#wt-next{background:#1a3a6a;border:1px solid #2a5a9a;color:#a0c8f0;border-radius:6px;
    padding:6px 14px;font-size:12px;cursor:pointer;transition:all .15s}
  #wt-prev:hover,#wt-next:hover{background:#2a4a7a;border-color:#4ea1d3;color:#fff}
  #wt-reopen{position:fixed;bottom:12px;right:12px;width:30px;height:30px;border-radius:50%;
    background:#0d1b30;border:1px solid #2a4a7a;color:#6a9abf;font-size:14px;cursor:pointer;
    z-index:500;display:flex;align-items:center;justify-content:center;line-height:1}
  #wt-reopen:hover{border-color:#4ea1d3;color:#e0f0ff}
"""

# Game Hub CSS
GAME_CSS = """\
  /* ── GAME HUB ─────────────────────────────────────────────── */
  #gamehub{position:fixed;inset:0;z-index:950;background:rgba(4,10,24,.97);
    display:none;flex-direction:column;align-items:center;overflow-y:auto}
  #gamehub.open{display:flex}
  #gh-header{width:100%;max-width:860px;padding:16px 20px;display:flex;align-items:center;gap:12px;
    border-bottom:1px solid #1a2a4a;flex-shrink:0;box-sizing:border-box}
  #gh-header h2{margin:0;font-size:20px;color:#e0f0ff;flex:1;font-family:ui-sans-serif,system-ui}
  #gh-close{background:none;border:none;color:#9aacbf;font-size:24px;cursor:pointer;padding:4px 8px;line-height:1}
  #gh-close:hover{color:#fff}
  #gh-select{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;padding:20px;max-width:860px;width:100%;box-sizing:border-box}
  .gh-card{background:#0d1b30;border:1px solid #1e3050;border-radius:12px;padding:18px 14px;
    display:flex;flex-direction:column;align-items:center;gap:8px;position:relative;font-family:ui-sans-serif,system-ui}
  .gh-card:not(.disabled){cursor:default}
  .gh-card.disabled{opacity:.38;pointer-events:none}
  .gh-card-icon{font-size:34px;line-height:1}
  .gh-card h3{margin:0;font-size:13px;color:#e0f0ff;text-align:center}
  .gh-card p{margin:0;font-size:11px;color:#6a8aaf;text-align:center;line-height:1.4}
  .gh-card-btns{display:flex;gap:6px;margin-top:4px;flex-wrap:wrap;justify-content:center}
  .gh-play-btn{background:#1a3a6a;border:1px solid #2a5a9a;color:#a0c8f0;border-radius:6px;
    padding:5px 14px;font-size:12px;cursor:pointer;transition:all .15s}
  .gh-play-btn:hover{background:#2a4a7a;border-color:#4ea1d3;color:#fff}
  .gh-shh-btn{background:#3a1a0a;border:1px solid #7a3a1a;color:#f0a060;border-radius:6px;
    padding:5px 10px;font-size:11px;cursor:pointer;transition:all .15s;white-space:nowrap}
  .gh-shh-btn:hover{background:#5a2a0a;border-color:#d06020;color:#ffd0a0}
  .gh-soon{position:absolute;top:7px;right:8px;font-size:9px;background:#0a2040;
    color:#4a6a8a;padding:2px 6px;border-radius:4px;letter-spacing:.5px;text-transform:uppercase}
  /* Pixel Surgeon */
  #gh-ps{display:none;flex-direction:column;width:100%;max-width:860px;padding:0 20px 20px;gap:10px;box-sizing:border-box}
  #gh-ps.active{display:flex}
  #ps-hdr{display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid #1a2a4a;flex-wrap:wrap}
  #ps-level-badge{background:#1a3a6a;border:1px solid #2a5a9a;color:#a0c8f0;border-radius:6px;
    padding:3px 10px;font-size:13px;font-weight:600;font-family:ui-sans-serif,system-ui;white-space:nowrap}
  #ps-shh-badge{background:#3a1a0a;border:1px solid #7a3a1a;color:#f0a060;border-radius:6px;
    padding:3px 8px;font-size:11px;font-weight:600;display:none}
  #ps-score-disp{color:#e0f0ff;font-size:14px;font-variant-numeric:tabular-nums;font-family:ui-sans-serif,system-ui}
  .ps-lives{display:flex;gap:3px}
  .ps-heart{font-size:16px;transition:all .3s;line-height:1}
  .ps-heart.lost{opacity:.18;transform:scale(.65)}
  #ps-timer-bar{flex:1;height:5px;background:#0d1b30;border-radius:3px;overflow:hidden;min-width:60px}
  #ps-timer-fill{height:100%;background:linear-gradient(90deg,#2a8a4a,#d4a017,#c0392b);background-size:300% 100%;
    background-position:0%;border-radius:3px;transition:width .25s linear,background-position .25s}
  #ps-body{display:grid;grid-template-columns:1fr 1fr;gap:14px}
  #ps-left{display:flex;flex-direction:column;gap:10px;align-items:center}
  #ps-canvas{border-radius:8px;border:2px solid #1e3050;display:block;max-width:300px;width:100%;
    image-rendering:pixelated;transition:filter .15s}
  #ps-symptoms{background:#08131f;border:1px solid #1a2a4a;border-radius:8px;
    padding:10px;width:100%;box-sizing:border-box}
  #ps-symptoms h4{margin:0 0 6px;font-size:10px;color:#6a8aaf;text-transform:uppercase;letter-spacing:.6px;font-family:ui-sans-serif,system-ui}
  .ps-symptom{font-size:12px;color:#c0d8f0;padding:2px 0;display:flex;align-items:flex-start;gap:6px;line-height:1.4;font-family:ui-sans-serif,system-ui}
  .ps-symptom::before{content:"\\25E6";color:#4ea1d3;flex-shrink:0}
  #ps-right{display:flex;flex-direction:column;gap:8px}
  #ps-ops-label{font-size:10px;color:#6a8aaf;text-transform:uppercase;letter-spacing:.6px;font-family:ui-sans-serif,system-ui}
  .ps-op{background:#0d1b30;border:2px solid #1e3050;border-radius:8px;padding:10px 12px;
    cursor:pointer;transition:border-color .15s,background .15s;display:flex;align-items:flex-start;gap:9px}
  .ps-op:hover{border-color:#4ea1d3;background:#122040}
  .ps-op.wrong{border-color:#8a2a2a!important;background:#1a0808!important;animation:ps-shake .35s}
  .ps-op.correct{border-color:#2a8a4a!important;background:#081e10!important}
  .ps-op-sym{font-size:18px;line-height:1.2;flex-shrink:0}
  .ps-op-text{flex:1;min-width:0}
  .ps-op-label{font-size:12px;color:#e0f0ff;font-weight:600;font-family:ui-sans-serif,system-ui}
  .ps-op-stage{font-size:10px;color:#6a8aaf;margin-top:2px;font-family:ui-sans-serif,system-ui}
  .ps-new-badge{background:#1a4a2a;border:1px solid #2a8a4a;color:#60d080;border-radius:4px;
    font-size:8px;padding:1px 4px;margin-left:5px;letter-spacing:.3px;vertical-align:middle}
  @keyframes ps-shake{0%,100%{transform:translateX(0)}25%{transform:translateX(-6px)}75%{transform:translateX(5px)}}
  #ps-feedback{min-height:28px;padding:6px 10px;border-radius:6px;font-size:12px;text-align:center;
    transition:opacity .25s;opacity:0;font-family:ui-sans-serif,system-ui}
  #ps-feedback.show{opacity:1}
  #ps-feedback.ok{background:#0d2a18;color:#60d080;border:1px solid #2a6a40}
  #ps-feedback.err{background:#1a0808;color:#f07070;border:1px solid #6a2a2a}
  #ps-new-op-banner{background:linear-gradient(135deg,#0d2a18,#1a4a2a);border:1px solid #2a8a4a;
    border-radius:8px;padding:10px 14px;text-align:center;display:none;animation:ps-fadein .4s}
  #ps-new-op-banner.show{display:block}
  #ps-new-op-banner h4{margin:0 0 3px;color:#60d080;font-size:13px;font-family:ui-sans-serif,system-ui}
  #ps-new-op-banner p{margin:0;font-size:11px;color:#80b090;font-family:ui-sans-serif,system-ui}
  @keyframes ps-fadein{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}
  /* Victory */
  #ps-victory{display:none;position:absolute;inset:0;background:rgba(4,12,20,.9);z-index:10;
    align-items:center;justify-content:center;flex-direction:column;gap:12px;border-radius:12px;text-align:center}
  #ps-victory.show{display:flex}
  #ps-victory h2{margin:0;font-size:28px;color:#60d080;font-family:ui-sans-serif,system-ui;animation:ps-fadein .5s}
  #ps-victory p{margin:0;font-size:14px;color:#9acfb0;font-family:ui-sans-serif,system-ui}
  /* Leaderboard */
  #gh-lb{display:none;flex-direction:column;align-items:center;gap:14px;padding:20px;max-width:520px;width:100%;box-sizing:border-box}
  #gh-lb.active{display:flex}
  #gh-lb-title{font-size:20px;font-weight:700;color:#e0f0ff;font-family:ui-sans-serif,system-ui}
  #gh-lb-score-wrap{text-align:center}
  #gh-lb-score{font-size:40px;font-weight:700;color:#4ea1d3;font-variant-numeric:tabular-nums;font-family:ui-sans-serif,system-ui;display:block}
  #gh-lb-rank{font-size:13px;color:#6a8aaf;font-family:ui-sans-serif,system-ui;margin-top:4px;display:block}
  #gh-lb-table{width:100%;background:#08131f;border:1px solid #1a2a4a;border-radius:8px;overflow:hidden}
  .lb-row{display:grid;grid-template-columns:30px 1fr 70px 70px;padding:7px 10px;font-size:11px;
    border-bottom:1px solid #0d1b30;align-items:center;font-family:ui-sans-serif,system-ui}
  .lb-row:last-child{border:none}
  .lb-row.header{background:#0d1b30;color:#6a8aaf;font-size:9px;letter-spacing:.5px;text-transform:uppercase}
  .lb-row.you{background:#0d2a40;color:#a0d8f8}
  .lb-rank-cell{color:#4a6a8a;font-weight:600}
  .lb-rank-cell.top3{color:#d4a017}
  .lb-name-cell{color:#c0d8f0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .lb-pts{color:#e0f0ff;font-variant-numeric:tabular-nums;text-align:right}
  .lb-date{color:#4a6a8a;text-align:right;font-size:9px}
  #gh-lb-btns{display:flex;gap:10px;flex-wrap:wrap;justify-content:center}
  .lb-action-btn{background:#0d1b30;border:1px solid #1e3050;color:#a0c8f0;border-radius:6px;
    padding:7px 16px;font-size:12px;cursor:pointer;transition:all .15s;font-family:ui-sans-serif,system-ui}
  .lb-action-btn:hover{border-color:#4ea1d3;color:#fff}
  /* SHH banner */
  #ps-shh-info{background:linear-gradient(135deg,#2a1005,#4a2010);border:1px solid #8a4020;
    border-radius:8px;padding:8px 14px;text-align:center;display:none}
  #ps-shh-info.show{display:block}
  #ps-shh-info h4{margin:0 0 2px;color:#f0a060;font-size:12px;font-family:ui-sans-serif,system-ui}
  #ps-shh-info p{margin:0;font-size:10px;color:#c09070;font-family:ui-sans-serif,system-ui}
  /* SHH leaderboard tab */
  .gh-lb-tabs{display:flex;gap:0;border:1px solid #1a2a4a;border-radius:6px;overflow:hidden;width:100%}
  .gh-lb-tab{flex:1;padding:6px;text-align:center;font-size:12px;cursor:pointer;font-family:ui-sans-serif,system-ui;
    background:#0d1b30;color:#6a8aaf;border:none;transition:all .15s}
  .gh-lb-tab.active{background:#1a3a6a;color:#e0f0ff}
"""

# Inject CSS before </style>
STYLE_CLOSE = '</style>'
first_style_close = html.find(STYLE_CLOSE)
assert first_style_close >= 0, "No </style> found"
html = html[:first_style_close] + MATH_CSS + WT_CSS + GAME_CSS + '\n' + html[first_style_close:]
print("Step 2: CSS injected")

# ─────────────────────────────────────────────────────────────────────────────
# STEP 3 — JS: drawEdges patch (add connOn + showlbl)
# ─────────────────────────────────────────────────────────────────────────────
OLD_DRAWEDGES = '''\
function drawEdges(){
  buildRepEdges();
  const showAll=document.getElementById("showconn").checked;
  repEdges.forEach(re=>{'''
NEW_DRAWEDGES = '''\
function drawEdges(){
  buildRepEdges();
  const connOn=document.getElementById("showconn").checked;
  const showAll=document.getElementById("showlbl")?.checked||false;
  if(!connOn && !flowSet && !selEdge) return;
  repEdges.forEach(re=>{
    if(!connOn && flowSet && !re.edges.some(e=>flowSet.has(e.f))) return;'''
assert OLD_DRAWEDGES in html, "drawEdges pattern not found"
html = html.replace(OLD_DRAWEDGES, NEW_DRAWEDGES)
print("Step 3: drawEdges patched")

# ─────────────────────────────────────────────────────────────────────────────
# STEP 4 — JS: updateHud zoomlbl → show zoom value
# ─────────────────────────────────────────────────────────────────────────────
OLD_ZOOM = '  zoomlbl.textContent = GRAPH.generated ? ("gen "+GRAPH.generated) : "";'
NEW_ZOOM = '  const _zv=(cam.scale*100/0.2|0)/100; zoomlbl.textContent = _zv+"\xd7";'
assert OLD_ZOOM in html, "zoomlbl textContent not found"
html = html.replace(OLD_ZOOM, NEW_ZOOM)
print("Step 4: zoomlbl zoom value patched")

# ─────────────────────────────────────────────────────────────────────────────
# STEP 5 — JS: add _tickerState + ticker animation in drawBoxes
# ─────────────────────────────────────────────────────────────────────────────
OLD_STATE = 'let hovId=null, selId=null, selEdge=null, hovEdge=null, drag=null;'
NEW_STATE = 'let hovId=null, selId=null, selEdge=null, hovEdge=null, drag=null;\nconst _tickerState=new Map();'
assert OLD_STATE in html, "state vars not found"
html = html.replace(OLD_STATE, NEW_STATE)

OLD_EXP_LABEL = '''\
        if(exp && sw > 80 && sh > 26){
          const iconW = ctx.measureText(sym).width;
          const lblSz = Math.min(iconSz, 16);
          ctx.font=`600 ${lblSz}px ui-sans-serif`;
          ctx.fillStyle=hex(col,0.82);
          const raw=(node.l||'').replace(/★/g,'').trim();
          const lbl=fitText(raw, sx+sw-icx-iconW-24);
          ctx.fillText(lbl, icx+iconW+4, icy+Math.max(0,(iconSz-lblSz)*0.45));
        }'''
NEW_EXP_LABEL = '''\
        if(exp && sw > 80 && sh > 26){
          const iconW = ctx.measureText(sym).width;
          const lblSz = Math.min(iconSz, 16);
          ctx.font=`600 ${lblSz}px ui-sans-serif`;
          ctx.fillStyle=hex(col,0.82);
          const raw=(node.l||'').replace(/★/g,'').trim();
          const avail=sx+sw-icx-iconW-28;
          const fullW=ctx.measureText(raw).width;
          if(fullW<=avail){
            ctx.fillText(raw, icx+iconW+4, icy+Math.max(0,(iconSz-lblSz)*0.45));
          } else {
            const tid=node.id, now2=performance.now();
            if(!_tickerState.has(tid)) _tickerState.set(tid,{off:0,vel:0.04,pause:0,dir:1});
            const ts=_tickerState.get(tid);
            const maxOff=fullW-avail+8;
            if(ts.pause>now2){/* paused */}
            else{
              ts.off+=ts.vel*ts.dir;
              if(ts.off>=maxOff){ts.off=maxOff;ts.dir=-1;ts.pause=now2+500;}
              else if(ts.off<=0){ts.off=0;ts.dir=1;ts.pause=now2+500;}
            }
            const tx=icx+iconW+4, ty=icy+Math.max(0,(iconSz-lblSz)*0.45);
            ctx.save();
            ctx.beginPath(); ctx.rect(tx-2,icy-2,avail+4,iconSz+4); ctx.clip();
            ctx.fillText(raw, tx-ts.off, ty);
            ctx.restore();
          }
        }'''

# Try to find + replace (the star char in the source may vary)
if OLD_EXP_LABEL in html:
    html = html.replace(OLD_EXP_LABEL, NEW_EXP_LABEL)
    print("Step 5: ticker animation patched")
else:
    print("Step 5: WARNING ticker pattern not found verbatim — checking alternate")
    alt = '''\
          const raw=(node.l||'').replace(/★/g,'').trim();
          const lbl=fitText(raw, sx+sw-icx-iconW-24);
          ctx.fillText(lbl, icx+iconW+4, icy+Math.max(0,(iconSz-lblSz)*0.45));
        }'''
    if alt in html:
        html = html.replace(alt,
          '''\
          const raw=(node.l||'').replace(/★/g,'').trim();
          const avail=sx+sw-icx-iconW-28;
          const fullW=ctx.measureText(raw).width;
          if(fullW<=avail){
            ctx.fillText(raw, icx+iconW+4, icy+Math.max(0,(iconSz-lblSz)*0.45));
          } else {
            const tid=node.id, now2=performance.now();
            if(!_tickerState.has(tid)) _tickerState.set(tid,{off:0,vel:0.04,pause:0,dir:1});
            const ts=_tickerState.get(tid);
            const maxOff=fullW-avail+8;
            if(ts.pause>now2){/* paused */}
            else{
              ts.off+=ts.vel*ts.dir;
              if(ts.off>=maxOff){ts.off=maxOff;ts.dir=-1;ts.pause=now2+500;}
              else if(ts.off<=0){ts.off=0;ts.dir=1;ts.pause=now2+500;}
            }
            const tx=icx+iconW+4, ty=icy+Math.max(0,(iconSz-lblSz)*0.45);
            ctx.save();
            ctx.beginPath(); ctx.rect(tx-2,icy-2,avail+4,iconSz+4); ctx.clip();
            ctx.fillText(raw, tx-ts.off, ty);
            ctx.restore();
          }
        }''')
        print("Step 5: ticker patched via alt pattern")
    else:
        print("Step 5: SKIP — pattern not found")

# ─────────────────────────────────────────────────────────────────────────────
# STEP 6 — JS: egg-timer click handler + showEggTimerPop
# ─────────────────────────────────────────────────────────────────────────────
OLD_GB_CLICK = '''\
      const gb=gitBarRects.find(r=>e.clientX>=r.barX&&e.clientX<=r.barX+r.barW&&e.clientY>=r.barY&&e.clientY<=r.barY+r.barH);
      if(gb){ showGitPop(gb, e.clientX, e.clientY); drag=null; return; }'''
NEW_GB_CLICK = '''\
      const _cutoff=HEATMAP_DATA.dates[heatIdx];
      const _etNode=rendered.find(r=>{
        if(!HEATMAP_DATA.nodes[r.node.id]||!HEATMAP_DATA.nodes[r.node.id][_cutoff]) return false;
        const cx=r.sx+r.sw*0.5, cy=r.sy+r.sh*0.08+Math.max(6,r.sh*0.04);
        const fs=Math.max(9,Math.min(22,r.sh*0.20));
        return Math.hypot(e.clientX-cx,e.clientY-cy)<Math.max(fs,14);
      });
      if(_etNode){ showEggTimerPop(_etNode.node, e.clientX, e.clientY); drag=null; return; }
      const gb=gitBarRects.find(r=>e.clientX>=r.barX&&e.clientX<=r.barX+r.barW&&e.clientY>=r.barY&&e.clientY<=r.barY+r.barH);
      if(gb){ showGitPop(gb, e.clientX, e.clientY); drag=null; return; }'''
assert OLD_GB_CLICK in html, "gitBarRects click pattern not found"
html = html.replace(OLD_GB_CLICK, NEW_GB_CLICK)

EGGTIMER_FN = '''\
function showEggTimerPop(node, cx, cy){
  const cutoff=HEATMAP_DATA.dates[heatIdx];
  const commits=HEATMAP_DATA.nodes[node.id]?.[cutoff]||0;
  const pop=_gitpop;
  document.getElementById('gp-name').textContent=node.l||node.id;
  document.getElementById('gp-stat').textContent='Active on '+cutoff;
  document.getElementById('gp-pct').textContent=commits+' line-changes';
  const bar=document.getElementById('gp-bar');
  if(bar) bar.style.cssText='height:4px;background:rgba(240,120,30,0.7);width:100%;margin-top:4px;border-radius:2px';
  let extra=pop.querySelector('.et-extra');
  if(!extra){extra=document.createElement('div'); extra.className='et-extra';
    extra.style.cssText='margin-top:8px;font-size:11px;color:#9aacbf;line-height:1.5';
    pop.appendChild(extra);}
  extra.innerHTML='<b style="color:#e8f0ff">David Gwynne-Evans</b> &amp; AI collaborators<br>'+
    '<span style="color:var(--dim)">capebio@gmail.com · Casabio.org</span>';
  pop.style.display='block';
  pop.style.left=Math.min(cx+10,window.innerWidth-220)+'px';
  pop.style.top=Math.max(8,cy-80)+'px';
}
'''
DRAWEDGES_FN = 'function drawEdges(){'
html = html.replace(DRAWEDGES_FN, EGGTIMER_FN + DRAWEDGES_FN, 1)
print("Step 6: egg-timer handler added")

# ─────────────────────────────────────────────────────────────────────────────
# STEP 7 — JS: snake SVG font sizes (small text → readable)
# ─────────────────────────────────────────────────────────────────────────────
html = html.replace('font-size="9" fill="#4a6080" font-family="ui-sans-serif,sans-serif" letter-spacing=".8"',
                    'font-size="13" fill="#5a7a9a" font-family="ui-sans-serif,sans-serif" letter-spacing=".5" font-weight="700"')
# Stage ms labels
html = html.replace('font-size="9" fill="${col}" opacity=".9" font-family="ui-monospace,monospace"',
                    'font-size="12" fill="${col}" opacity=".9" font-family="ui-monospace,monospace"')
# HEAP MB label
html = html.replace('font-size="9" fill="#4a6080" font-family="ui-sans-serif,sans-serif" letter-spacing=".5">HEAP MB',
                    'font-size="13" fill="#5a7a9a" font-family="ui-sans-serif,sans-serif" letter-spacing=".5" font-weight="600">HEAP MB')
html = html.replace('font-size="9" fill="#3ab5d4" font-family="ui-monospace,monospace">${maxMem}MB',
                    'font-size="13" fill="#3ab5d4" font-family="ui-monospace,monospace">${maxMem}MB')
html = html.replace('font-size="8" fill="#3ab5d4" opacity=".7" font-family="ui-monospace,monospace">▲${maxMem}MB',
                    'font-size="11" fill="#3ab5d4" opacity=".7" font-family="ui-monospace,monospace">▲${maxMem}MB')
# Stage label sizes (template literal — use replace_all carefully)
html = re.sub(r'(font-size=")9(" fill="\$\{mc\})', r'112', html)  # placeholder
html = html.replace('font-size="9" fill="${mc}"', 'font-size="13" fill="${mc}"')
# Probe font
html = html.replace('font-size="9"\n', 'font-size="12"\n')
html = html.replace('font-size="8" fill="#f5c518"', 'font-size="11" fill="#f5c518"')
# Tick and band labels
html = html.replace('font-size="8"\n', 'font-size="12"\n')
html = html.replace('font-size="8" ', 'font-size="12" ')
print("Step 7: snake fonts patched")

# ─────────────────────────────────────────────────────────────────────────────
# STEP 8 — JS: _renderMath with copy + code link
# ─────────────────────────────────────────────────────────────────────────────
OLD_RENDER_MATH = '''\
function _renderMath(){
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
      +'<div class="math-desc">'+escapeHtml(e.desc)+'<'''

if OLD_RENDER_MATH in html:
    # Find full old function up to closing
    idx = html.find(OLD_RENDER_MATH)
    end = html.find('\n}', idx) + 2
    old_fn = html[idx:end]
    NEW_RENDER_MATH = '''\
function _copyMathFormula(formula){
  navigator.clipboard.writeText(formula).catch(()=>{});
  const el=event.currentTarget;
  const old=el.textContent; el.textContent='✓';
  setTimeout(()=>el.textContent=old, 1500);
}
function _openNodeForPath(src){
  const node=GRAPH.nodes.find(n=>n.path&&n.path.replace(/\\\\/g,'/').endsWith(src.replace(/\\\\/g,'/')));
  if(node){ selectNode(node); animTo(node.rect.x+node.rect.w/2, node.rect.y+node.rect.h/2, 2.5); }
  else { alert('Node for '+src+' not currently on the map.'); }
}
function _renderMath(){
  let h=''; let curCat='';
  for(const e of MATH_DICT){
    if(e.cat!==curCat){ curCat=e.cat; h+='<div class="dict-alpha">'+e.cat+'</div>'; }
    const nameJ=JSON.stringify(e.name);
    const srcLink=e.src
      ?'<a href="#" class="math-src-link" onclick="_openNodeForPath('+JSON.stringify(e.src)+');return false;" title="Jump to file in map">\U0001f4c2 '+escapeHtml(e.src.split('/').pop())+'</a>'
      :'<span class="math-src-link" style="color:#3a5070;font-style:italic">theoretical</span>';
    h+='<div class="math-entry">'
      +'<div class="math-name">'+escapeHtml(e.name)+'</div>'
      +'<div class="math-formula" style="position:relative">'
      +'<button class="math-copy-btn" onclick="_copyMathFormula(MATH_DICT.find(x=>x.name==='+nameJ+').formula)">\U0001f4cb</button>'
      +escapeHtml(e.formula)+'</div>'
      +'<div class="math-desc">'+escapeHtml(e.desc)+'</div>'
      +'<div class="math-src-row">'+srcLink+'</div>'
      +'</div>';
  }
  return h;
}'''
    html = html[:idx] + NEW_RENDER_MATH + html[end:]
    print("Step 8: _renderMath patched")
else:
    print("Step 8: WARNING _renderMath open pattern not found — skip")

# ─────────────────────────────────────────────────────────────────────────────
# STEP 9 — Add src fields to MATH_DICT entries
# ─────────────────────────────────────────────────────────────────────────────
MATH_SRC = {
    "MSE — Mean Squared Error": "crates/raw-pipeline/src/perceptual/ssim.rs",
    "PSNR — Peak Signal-to-Noise Ratio": "crates/raw-pipeline/src/perceptual/ssim.rs",
    "SSIM — Structural Similarity Index": "crates/raw-pipeline/src/perceptual/ssim.rs",
    "Butteraugli p-norm": "crates/raw-pipeline/src/perceptual/butteraugli_kernel.rs",
    "sRGB EOTF": "crates/raw-pipeline/src/pipeline.rs",
    "EMA — Exponential Moving Average": "packages/jxl-worker-browser/src/decode-handler.ts",
    "FNV-1a": "packages/jxl-cache/src/browser.ts",
}
for name, src in MATH_SRC.items():
    search = f'name:"{name}"'
    if search not in html:
        print(f"Step 9: name not found: {name}")
        continue
    idx = html.index(search)
    close = html.find('},', idx)
    close2 = html.find('}]', idx)
    end_entry = min(c for c in [close, close2] if c >= 0)
    if 'src:' not in html[idx:end_entry]:
        html = html[:end_entry] + f',\n src:"{src}"' + html[end_entry:]
print("Step 9: MATH_DICT src fields added")

# ─────────────────────────────────────────────────────────────────────────────
# STEP 10 — Add walkthrough HTML + JS
# ─────────────────────────────────────────────────────────────────────────────
WALKTHROUGH_HTML = '''\
<!-- walkthrough overlay -->
<div id="wt-overlay">
  <div id="wt-bg"></div>
  <div id="wt-spotlight"></div>
  <div id="wt-card">
    <div id="wt-step-indicator"></div>
    <div id="wt-icon"></div>
    <h3 id="wt-title"></h3>
    <p id="wt-body"></p>
    <div id="wt-actions">
      <button id="wt-skip">Skip tour</button>
      <span style="flex:1"></span>
      <button id="wt-prev">← Back</button>
      <button id="wt-next">Next →</button>
    </div>
  </div>
</div>
<button id="wt-reopen" title="Reopen tour">?</button>
'''
# Insert before </body>
html = html.replace('</body>', WALKTHROUGH_HTML + '\n</body>', 1)

WALKTHROUGH_JS = r'''
/* ── WALKTHROUGH ─────────────────────────────────────────── */
(function(){
  const STEPS=[
    {icon:'🌍',title:'Welcome to the ecosystem map',body:'Scroll or pinch-zoom to explore. Drag to pan. Click any node for details.',target:null,pos:'center'},
    {icon:'🔍',title:'Find anything instantly',body:'Type a module name, algorithm, or keyword — the map flies to it.',target:'#search',pos:'below'},
    {icon:'🖱️',title:'Inspect any node',body:'Click a node to open the details panel. See connections, payloads, and file paths.',target:'#panel',pos:'left'},
    {icon:'▶',title:'Trace data flow',body:'Click "Trace data flow" in the panel to follow data through the pipeline.',target:'#ptrace',pos:'left'},
    {icon:'🔥',title:'Git heat map',body:'Watch 36 days of commit activity play back across the graph.',target:'#heatplayer',pos:'above'},
    {icon:'◆',title:'Architectural seams',body:'Highlight the layer boundaries where data crosses system borders.',target:'#seamtoggle',pos:'below'},
    {icon:'🐍',title:'Pipeline timing snake',body:'See real decode/encode stage timings scaled to your chosen megapixel count.',target:'#snakebtn',pos:'below'},
    {icon:'📖',title:'Glossary & equations',body:'Browse the mathematical formulae that power this codec pipeline — with copy buttons.',target:'#dictbtn',pos:'below'},
    {icon:'🎮',title:'Test your knowledge',body:'Play Pixel Surgeon and more games to learn the system through play.',target:'#gamebtn',pos:'below'},
  ];
  let cur=0;
  const overlay=document.getElementById('wt-overlay');
  const spot=document.getElementById('wt-spotlight');
  const card=document.getElementById('wt-card');
  function show(i){
    cur=i; if(cur<0)cur=0; if(cur>=STEPS.length){ close(); return; }
    const s=STEPS[cur];
    document.getElementById('wt-icon').textContent=s.icon;
    document.getElementById('wt-title').textContent=s.title;
    document.getElementById('wt-body').textContent=s.body;
    document.getElementById('wt-prev').style.display=cur===0?'none':'';
    document.getElementById('wt-next').textContent=cur===STEPS.length-1?'Done ✓':'Next →';
    const dots=document.getElementById('wt-step-indicator');
    dots.innerHTML=STEPS.map((_,j)=>'<div class="wt-dot'+(j===cur?' active':'')+'"></div>').join('');
    if(s.target){
      const el=document.querySelector(s.target);
      if(el){
        const r=el.getBoundingClientRect();
        const pad=8;
        spot.style.cssText=`left:${r.left-pad}px;top:${r.top-pad}px;width:${r.width+pad*2}px;height:${r.height+pad*2}px`;
        const cw=320, ch=200, margin=14;
        let cx, cy;
        if(s.pos==='below'){ cx=r.left+r.width/2-cw/2; cy=r.bottom+margin; }
        else if(s.pos==='above'){ cx=r.left+r.width/2-cw/2; cy=r.top-ch-margin; }
        else if(s.pos==='left'){ cx=r.left-cw-margin; cy=r.top+r.height/2-ch/2; }
        else { cx=r.right+margin; cy=r.top+r.height/2-ch/2; }
        cx=Math.max(10,Math.min(cx,window.innerWidth-cw-10));
        cy=Math.max(10,Math.min(cy,window.innerHeight-ch-10));
        card.style.cssText=`left:${cx}px;top:${cy}px`;
      } else {
        center();
      }
    } else { center(); spot.style.cssText='display:none'; }
    overlay.classList.add('show');
  }
  function center(){ spot.style.cssText='display:none'; card.style.cssText='left:50%;top:50%;transform:translate(-50%,-50%)'; }
  function close(){ overlay.classList.remove('show'); localStorage.setItem('wt_seen','1'); }
  document.getElementById('wt-next').onclick=()=>show(cur+1);
  document.getElementById('wt-prev').onclick=()=>show(cur-1);
  document.getElementById('wt-skip').onclick=close;
  document.getElementById('wt-bg').onclick=close;
  document.getElementById('wt-reopen').onclick=()=>show(0);
  setTimeout(()=>{ if(!localStorage.getItem('wt_seen')) show(0); }, 900);
}());
'''

# ─────────────────────────────────────────────────────────────────────────────
# STEP 11 — Add Game Hub HTML before </body>
# ─────────────────────────────────────────────────────────────────────────────
GAMEHUB_HTML = '''\
<!-- GAME HUB -->
<div id="gamehub">
  <div id="gh-header">
    <h2>\U0001f3ae Knowledge Arena</h2>
    <button id="gh-close">\xd7</button>
  </div>

  <!-- Game select grid -->
  <div id="gh-select">
    <div class="gh-card" id="ghc-ps">
      <div class="gh-card-icon">\U0001f52c</div>
      <h3>Pixel Surgeon</h3>
      <p>Diagnose corrupted pipeline stages from visual symptoms on fractal images</p>
      <div class="gh-card-btns">
        <button class="gh-play-btn" onclick="ghStartGame('pixel-surgeon',false)">▶ Play</button>
        <button class="gh-shh-btn" onclick="ghStartGame('pixel-surgeon',true)">⚡ SHH</button>
      </div>
    </div>
    <div class="gh-card disabled"><div class="gh-card-icon">\U0001f9ed</div><h3>Dead Reckoning</h3><p>Find the path between two nodes in 6 guesses</p><div class="gh-soon">Coming soon</div></div>
    <div class="gh-card disabled"><div class="gh-card-icon">\U0001f40d</div><h3>Snake Charmer</h3><p>Assemble a pipeline within time &amp; memory budget</p><div class="gh-soon">Coming soon</div></div>
    <div class="gh-card disabled"><div class="gh-card-icon">\U0001f575️</div><h3>Git Blame Noir</h3><p>Deduce the bug’s origin from git evidence cards</p><div class="gh-soon">Coming soon</div></div>
    <div class="gh-card disabled"><div class="gh-card-icon">\U0001f30a</div><h3>The Flood</h3><p>Place pipeline gates before corrupt data arrives</p><div class="gh-soon">Coming soon</div></div>
    <div class="gh-card disabled"><div class="gh-card-icon">⛳</div><h3>Codec Golf</h3><p>Write the shortest MA tree program for a target image</p><div class="gh-soon">Coming soon</div></div>
  </div>

  <!-- Pixel Surgeon game screen -->
  <div id="gh-ps">
    <div id="ps-hdr">
      <span id="ps-level-badge">Level 1</span>
      <span id="ps-shh-badge">⚡ SHH</span>
      <span id="ps-score-disp">Score: <b id="ps-score-val">0</b></span>
      <div class="ps-lives" id="ps-lives-wrap">
        <span class="ps-heart">♥</span><span class="ps-heart">♥</span><span class="ps-heart">♥</span>
      </div>
      <div id="ps-timer-bar"><div id="ps-timer-fill"></div></div>
      <button class="lb-action-btn" style="margin-left:auto;padding:4px 10px;font-size:11px" onclick="psQuit()">← Exit</button>
    </div>
    <div id="ps-shh-info">
      <h4>⚡ Shit Hot Hacker Mode</h4>
      <p>All corruptions active. 3 lives. Score as many rounds as you can survive.</p>
    </div>
    <div id="ps-new-op-banner">
      <h4>\U0001f513 New corruption unlocked!</h4>
      <p id="ps-new-op-desc"></p>
    </div>
    <div id="ps-body">
      <div id="ps-left">
        <div style="position:relative;width:100%">
          <canvas id="ps-canvas" width="300" height="300"></canvas>
          <div id="ps-victory">
            <h2>\U0001f3af Correct!</h2>
            <p id="ps-victory-pts"></p>
          </div>
        </div>
        <div id="ps-symptoms"><h4>Observed symptoms</h4><div id="ps-symptom-list"></div></div>
        <div id="ps-feedback"></div>
      </div>
      <div id="ps-right">
        <div id="ps-ops-label">Diagnose the stage failure:</div>
        <div id="ps-ops-list"></div>
      </div>
    </div>
  </div>

  <!-- Leaderboard -->
  <div id="gh-lb">
    <div id="gh-lb-title">\U0001f3c6 Game Over</div>
    <div id="gh-lb-score-wrap">
      <span id="gh-lb-score">0</span>
      <span id="gh-lb-rank"></span>
    </div>
    <div class="gh-lb-tabs">
      <button class="gh-lb-tab active" onclick="ghShowLbTab('normal')">Normal</button>
      <button class="gh-lb-tab" onclick="ghShowLbTab('shh')">⚡ SHH</button>
    </div>
    <div id="gh-lb-table"></div>
    <div id="gh-lb-btns">
      <button class="lb-action-btn" onclick="ghPlayAgain()">▶ Play Again</button>
      <button class="lb-action-btn" onclick="ghShowSelect()">← Games</button>
    </div>
  </div>
</div>
'''

html = html.replace('</body>', GAMEHUB_HTML + '\n</body>', 1)

# ─────────────────────────────────────────────────────────────────────────────
# STEP 12 — Add Game Hub + Pixel Surgeon JS
# ─────────────────────────────────────────────────────────────────────────────
GAME_JS = r"""
/* ═══════════════════════════════════════════════════════════
   GAME HUB
   ═══════════════════════════════════════════════════════════ */
(function(){
  const hub=document.getElementById('gamehub');
  const gamebtn=document.getElementById('gamebtn');
  if(gamebtn) gamebtn.onclick=()=>{ hub.classList.add('open'); ghShowSelect(); };
  document.getElementById('gh-close').onclick=()=>hub.classList.remove('open');
  hub.addEventListener('click',e=>{ if(e.target===hub) hub.classList.remove('open'); });
}());

function ghShowSelect(){
  document.getElementById('gh-select').style.display='';
  document.getElementById('gh-ps').classList.remove('active');
  document.getElementById('gh-lb').classList.remove('active');
}
function ghStartGame(id, shh){
  document.getElementById('gh-select').style.display='none';
  document.getElementById('gh-lb').classList.remove('active');
  if(id==='pixel-surgeon'){
    document.getElementById('gh-ps').classList.add('active');
    psInit(shh);
  }
}
function ghPlayAgain(){
  if(typeof _lastGameId!=='undefined') ghStartGame(_lastGameId, _lastSHH);
  else ghShowSelect();
}
let _lastGameId='pixel-surgeon', _lastSHH=false;

/* ─── Leaderboard helpers ─────────────────────────────────── */
function ghGetLb(shh){ try{return JSON.parse(localStorage.getItem(shh?'gh_lb_shh':'gh_lb_ps')||'[]');}catch{return[];} }
function ghAddScore(name,score,shh){
  const key=shh?'gh_lb_shh':'gh_lb_ps';
  const lb=ghGetLb(shh);
  lb.push({name,score,date:new Date().toLocaleDateString()});
  lb.sort((a,b)=>b.score-a.score);
  lb.splice(20);
  localStorage.setItem(key,JSON.stringify(lb));
  return lb.findIndex(e=>e.name===name&&e.score===score);
}
let _ghLbMode='normal';
function ghShowLb(score, shh, rounds){
  _lastSHH=shh;
  const name=localStorage.getItem('gh_player_name')||'You';
  const rank=ghAddScore(name,score,shh);
  document.getElementById('gh-select').style.display='none';
  document.getElementById('gh-ps').classList.remove('active');
  const lb=document.getElementById('gh-lb');
  lb.classList.add('active');
  document.getElementById('gh-lb-title').textContent=shh?'⚡ SHH Round Over':'\U0001f3c6 Game Over';
  document.getElementById('gh-lb-score').textContent=score;
  document.getElementById('gh-lb-rank').textContent=rank===0?'\U0001f947 #1 All-time high!':rank<3?'\U0001f948 Top 3!':'Rank #'+(rank+1);
  _ghLbMode=shh?'shh':'normal';
  ghRenderLbTable(_ghLbMode==='shh');
  document.querySelectorAll('.gh-lb-tab').forEach((t,i)=>{
    t.classList.toggle('active',i===(shh?1:0));
  });
}
function ghShowLbTab(mode){
  _ghLbMode=mode;
  ghRenderLbTable(mode==='shh');
  document.querySelectorAll('.gh-lb-tab').forEach((t,i)=>t.classList.toggle('active',i===(mode==='shh'?1:0)));
}
function ghRenderLbTable(shh){
  const rows=ghGetLb(shh);
  const myName=localStorage.getItem('gh_player_name')||'You';
  let h='<div class="lb-row header"><div class="lb-rank-cell">#</div><div class="lb-name-cell">Player</div><div class="lb-pts">Score</div><div class="lb-date">Date</div></div>';
  rows.slice(0,10).forEach((r,i)=>{
    const you=r.name===myName;
    h+=`<div class="lb-row${you?' you':''}"><div class="lb-rank-cell${i<3?' top3':''}">${i+1}</div><div class="lb-name-cell">${r.name}</div><div class="lb-pts">${r.score}</div><div class="lb-date">${r.date}</div></div>`;
  });
  if(!rows.length) h+='<div class="lb-row"><div style="grid-column:1/-1;color:#4a6a8a;font-size:11px;padding:8px">No scores yet — be the first!</div></div>';
  document.getElementById('gh-lb-table').innerHTML=h;
}

/* ═══════════════════════════════════════════════════════════
   PIXEL SURGEON
   ═══════════════════════════════════════════════════════════ */
const PS_CORRUPTIONS=[
  {id:'tone_blown', label:'Blown highlights', stage:'Tone curve',
   desc:'Pixel values clamped — sky detail lost, bright areas wash out', sym:'☀️',
   symptoms:['Bright areas are flat and washed out','Sky/highlight detail is absent','Mid-tones look normal but peaks are cut']},
  {id:'channel_swap', label:'Magenta cast', stage:'Colour matrix',
   desc:'R and G channels transposed by faulty colour matrix', sym:'\U0001f7e3',
   symptoms:['Overall magenta/purple tint across image','Green foliage appears purple','Skin tones are strongly shifted']},
  {id:'blur_ema', label:'EMA trail blur', stage:'EMA decode',
   desc:'Exponential moving average bleeds each row into the next', sym:'〰',
   symptoms:['Horizontal smearing on vertical edges','Top of image cleaner than bottom','Trailing shadow behind shapes']},
  {id:'dct_block', label:'8\xd78 blocking', stage:'DCT quantise',
   desc:'Pixel coordinates rounded to 8px blocks — classic codec artifact', sym:'⬛',
   symptoms:['Visible grid of 8\xd78 pixel blocks','Smooth gradients replaced by stepped rectangles','Block boundaries sharp and regular']},
  {id:'gamma_skip', label:'Flat / grey-washed', stage:'sRGB EOTF',
   desc:'Gamma linearisation skipped — image looks crushed and grey', sym:'\U0001f32b️',
   symptoms:['Entire image appears grey and flat','Colours are correct hue but very desaturated','Blacks are not black — lifted to grey']},
  {id:'wb_shift', label:'Blue cast', stage:'White balance',
   desc:'White balance matrix offset — scene shifted toward blue', sym:'\U0001f535',
   symptoms:['Strong blue tint across entire image','White areas appear light blue','Warm colours such as reds are suppressed']},
];
function psOpsForLevel(lvl){
  if(lvl<=2) return PS_CORRUPTIONS.slice(0,3);
  if(lvl<=4) return PS_CORRUPTIONS.slice(0,4);
  if(lvl<=6) return PS_CORRUPTIONS.slice(0,5);
  return PS_CORRUPTIONS;
}

let psS=null; // game state
function psInit(shh){
  _lastGameId='pixel-surgeon'; _lastSHH=shh;
  psS={level:shh?10:1, score:0, lives:3, shh, rounds:0,
       corruption:null, fractal:null, timer:null, timeLeft:0,
       timeLimit:shh?8:20, ccRaf:null, solved:false};
  document.getElementById('ps-shh-badge').style.display=shh?'':'none';
  document.getElementById('ps-shh-info').classList.toggle('show', shh);
  psUpdateLives();
  psNextRound();
}
function psNextRound(){
  if(psS.ccRaf){ cancelAnimationFrame(psS.ccRaf); psS.ccRaf=null; }
  const cv=document.getElementById('ps-canvas');
  cv.style.filter='';
  document.getElementById('ps-victory').classList.remove('show');
  clearInterval(psS.timer);
  const prevCount=psOpsForLevel(Math.max(1,psS.level-1)).length;
  const ops=psOpsForLevel(psS.level);
  const isNew=ops.length>prevCount;
  psS.corruption=ops[Math.floor(Math.random()*ops.length)];
  psS.fractal=['mandelbrot','julia','sierpinski','plasma','barnsley'][Math.floor(Math.random()*5)];
  psS.solved=false; psS.rounds++;
  // New op banner
  const banner=document.getElementById('ps-new-op-banner');
  if(isNew && !psS.shh){
    const newOp=ops[ops.length-1];
    document.getElementById('ps-new-op-desc').textContent='New: '+newOp.label+' — '+newOp.stage;
    banner.classList.add('show');
    setTimeout(()=>banner.classList.remove('show'),3000);
  } else { banner.classList.remove('show'); }
  psDrawFractal(cv, psS.fractal);
  psApplyCorruption(cv, psS.corruption.id);
  psRenderOps(ops);
  psRenderSymptoms(psS.corruption);
  psUpdateHdr();
  psStartTimer();
}
function psRenderSymptoms(c){
  document.getElementById('ps-symptom-list').innerHTML=
    c.symptoms.map(s=>'<div class="ps-symptom">'+s+'</div>').join('');
}
function psRenderOps(ops){
  const prevOps=psOpsForLevel(Math.max(1,psS.level-1));
  const newId=ops.length>prevOps.length?ops[ops.length-1].id:null;
  document.getElementById('ps-ops-list').innerHTML=ops.map(op=>
    '<div class="ps-op" data-id="'+op.id+'" onclick="psGuess(\''+op.id+'\')">'
    +'<span class="ps-op-sym">'+op.sym+'</span>'
    +'<div class="ps-op-text">'
    +'<div class="ps-op-label">'+op.label+(op.id===newId&&!psS.shh?'<span class="ps-new-badge">NEW</span>':'')+'</div>'
    +'<div class="ps-op-stage">Pipeline stage: '+op.stage+'</div>'
    +'</div></div>'
  ).join('');
}
function psUpdateHdr(){
  document.getElementById('ps-level-badge').textContent=psS.shh?'SHH Mode':'Level '+psS.level;
  document.getElementById('ps-score-val').textContent=psS.score;
}
function psUpdateLives(){
  const hearts=document.querySelectorAll('.ps-heart');
  hearts.forEach((h,i)=>h.classList.toggle('lost', i>=psS.lives));
}
function psStartTimer(){
  const fill=document.getElementById('ps-timer-fill');
  psS.timeLeft=psS.timeLimit;
  fill.style.width='100%';
  fill.style.backgroundPosition='0%';
  psS.timer=setInterval(()=>{
    psS.timeLeft-=0.1;
    const pct=Math.max(0,psS.timeLeft/psS.timeLimit*100);
    fill.style.width=pct+'%';
    fill.style.backgroundPosition=(100-pct)+'%';
    if(psS.timeLeft<=0){ clearInterval(psS.timer); psTimeout(); }
  },100);
}
function psGuess(id){
  if(psS.solved) return;
  clearInterval(psS.timer);
  const correct=id===psS.corruption.id;
  const el=document.querySelector('.ps-op[data-id="'+id+'"]');
  const corrEl=document.querySelector('.ps-op[data-id="'+psS.corruption.id+'"]');
  if(correct){
    psS.solved=true;
    el.classList.add('correct');
    const pts=Math.max(10, Math.floor(psS.timeLeft/psS.timeLimit*100)+psS.level*5);
    psS.score+=pts;
    psShowFeedback('✓ Correct! +'+pts+' pts', true);
    psShowVictory(pts);
    psColorCycle();
    psFireConfetti();
    setTimeout(()=>{
      if(!psS.shh) psS.level++;
      psNextRound();
    }, 3200);
  } else {
    el.classList.add('wrong');
    setTimeout(()=>el.classList.remove('wrong'),500);
    corrEl&&corrEl.classList.add('correct');
    psS.lives--;
    psUpdateLives();
    psShowFeedback('✗ That was: '+psS.corruption.stage, false);
    if(psS.lives<=0){
      setTimeout(psGameOver, 1200);
    } else {
      setTimeout(()=>{corrEl&&corrEl.classList.remove('correct'); psNextRound();},1500);
    }
  }
}
function psTimeout(){
  if(psS.solved) return;
  const corrEl=document.querySelector('.ps-op[data-id="'+psS.corruption.id+'"]');
  corrEl&&corrEl.classList.add('correct');
  psS.lives--;
  psUpdateLives();
  psShowFeedback('⏱ Time! It was: '+psS.corruption.stage, false);
  if(psS.lives<=0){ setTimeout(psGameOver,1200); }
  else { setTimeout(()=>{corrEl&&corrEl.classList.remove('correct'); psNextRound();},1500); }
}
function psShowVictory(pts){
  const v=document.getElementById('ps-victory');
  document.getElementById('ps-victory-pts').textContent='+'+pts+' pts — '+(psS.shh?'Round '+psS.rounds:'Level '+psS.level);
  v.classList.add('show');
}
function psShowFeedback(msg, ok){
  const fb=document.getElementById('ps-feedback');
  fb.textContent=msg; fb.className='show '+(ok?'ok':'err');
  setTimeout(()=>fb.className='',2500);
}
function psColorCycle(){
  const cv=document.getElementById('ps-canvas');
  let h=0;
  function tick(){ cv.style.filter='hue-rotate('+h+'deg) saturate(1.6)'; h=(h+4)%360; psS.ccRaf=requestAnimationFrame(tick); }
  tick();
}
function psFireConfetti(){
  // Reuse existing confetti system
  if(typeof confetti!=='undefined' && document.getElementById('egg')){
    // trigger via the egg mechanism
    const fakeEgg={classList:{contains:()=>true}};
    confettiCv.width=window.innerWidth; confettiCv.height=window.innerHeight;
    confettiCv.style.display='block';
    confetti=[];
    for(let i=0;i<120;i++) confetti.push({
      x:window.innerWidth/2+(Math.random()-.5)*300,
      y:window.innerHeight*.4,
      vx:(Math.random()-.5)*8, vy:-(Math.random()*6+3),
      g:0.18, rot:Math.random()*360, vr:(Math.random()-.5)*4,
      life:1, w:8+Math.random()*8, h:5+Math.random()*5,
      col:['#4ea1d3','#60d080','#d4a017','#f07070','#c080f0'][Math.floor(Math.random()*5)]
    });
    if(confettiRAF) cancelAnimationFrame(confettiRAF);
    (function step(){
      cctx.clearRect(0,0,confettiCv.width,confettiCv.height);
      let alive=false;
      for(const p of confetti){
        p.vy+=p.g; p.x+=p.vx; p.y+=p.vy; p.rot+=p.vr; p.life-=0.008;
        if(p.life>0&&p.y<confettiCv.height+24){ alive=true;
          cctx.save(); cctx.globalAlpha=p.life; cctx.fillStyle=p.col;
          cctx.translate(p.x,p.y); cctx.rotate(p.rot*Math.PI/180);
          cctx.fillRect(-p.w/2,-p.h/2,p.w,p.h); cctx.restore();
        }
      }
      if(alive) confettiRAF=requestAnimationFrame(step);
      else{ confettiCv.style.display='none'; cctx.clearRect(0,0,confettiCv.width,confettiCv.height); }
    }());
  }
}
function psGameOver(){
  clearInterval(psS.timer);
  if(psS.ccRaf){ cancelAnimationFrame(psS.ccRaf); psS.ccRaf=null; }
  ghShowLb(psS.score, psS.shh, psS.rounds);
}
function psQuit(){ clearInterval(psS.timer); if(psS.ccRaf) cancelAnimationFrame(psS.ccRaf); ghShowSelect(); }

/* ── Fractal generators ──────────────────────────────────── */
function psDrawFractal(cv, type){
  const ctx=cv.getContext('2d'), W=cv.width, H=cv.height;
  if(type==='barnsley'){
    ctx.fillStyle='#0a1628'; ctx.fillRect(0,0,W,H);
    let x=0,y=0; ctx.fillStyle='rgba(50,200,80,0.6)';
    for(let i=0;i<80000;i++){
      const r=Math.random(); let nx,ny;
      if(r<.01){nx=0;ny=.16*y;}
      else if(r<.86){nx=.85*x+.04*y;ny=-.04*x+.85*y+1.6;}
      else if(r<.93){nx=.2*x-.26*y;ny=.23*x+.22*y+1.6;}
      else{nx=-.15*x+.28*y;ny=.26*x+.24*y+.44;}
      x=nx;y=ny;
      const px2=Math.floor((x+3)/6*W), py2=Math.floor((10-y)/10*H);
      if(px2>=0&&px2<W&&py2>=0&&py2<H) ctx.fillRect(px2,py2,1,1);
    }
    return;
  }
  const img=ctx.createImageData(W,H), d=img.data;
  if(type==='mandelbrot'){
    for(let py=0;py<H;py++) for(let px=0;px<W;px++){
      const cx2=(px/W)*3.5-2.5, cy2=(py/H)*2.0-1.0;
      let x=0,y=0,n=0; const MAX=64;
      while(x*x+y*y<=4&&n<MAX){const xt=x*x-y*y+cx2;y=2*x*y+cy2;x=xt;n++;}
      const t=n/MAX, i=(py*W+px)*4;
      d[i]=9*(1-t)*t*t*t*255|0; d[i+1]=15*(1-t)*(1-t)*t*t*255|0;
      d[i+2]=8.5*(1-t)*(1-t)*(1-t)*t*255|0; d[i+3]=255;
    }
  } else if(type==='julia'){
    const JX=-.7,JY=.27;
    for(let py=0;py<H;py++) for(let px=0;px<W;px++){
      let x=(px/W)*3.5-1.75,y=(py/H)*3.5-1.75,n=0; const MAX=64;
      while(x*x+y*y<=4&&n<MAX){const xt=x*x-y*y+JX;y=2*x*y+JY;x=xt;n++;}
      const t=n/MAX, i=(py*W+px)*4;
      d[i]=t*255|0; d[i+1]=t*t*255|0; d[i+2]=(1-t)*t*4*255|0; d[i+3]=255;
    }
  } else if(type==='sierpinski'){
    for(let py=0;py<H;py++) for(let px=0;px<W;px++){
      const v=(px&py)?0:255, i=(py*W+px)*4;
      d[i]=v; d[i+1]=Math.floor(v*.6); d[i+2]=Math.floor(v*.3); d[i+3]=255;
    }
  } else if(type==='plasma'){
    for(let py=0;py<H;py++) for(let px=0;px<W;px++){
      const v=(Math.sin(px/18)+Math.sin(py/18)+Math.sin((px+py)/18)+Math.sin(Math.sqrt(px*px+py*py)/18))/4;
      const t=(v+1)/2, i=(py*W+px)*4, TAU=Math.PI*2;
      d[i]=Math.sin(t*TAU)*127+128|0; d[i+1]=Math.sin(t*TAU+2.094)*127+128|0;
      d[i+2]=Math.sin(t*TAU+4.189)*127+128|0; d[i+3]=255;
    }
  }
  ctx.putImageData(img,0,0);
}

/* ── Corruption applicators ─────────────────────────────── */
function psApplyCorruption(cv, type){
  const ctx=cv.getContext('2d'), W=cv.width, H=cv.height;
  const img=ctx.getImageData(0,0,W,H), d=img.data;
  if(type==='tone_blown'){
    for(let i=0;i<d.length;i+=4){d[i]=Math.min(d[i],179);d[i+1]=Math.min(d[i+1],179);d[i+2]=Math.min(d[i+2],179);}
  } else if(type==='channel_swap'){
    for(let i=0;i<d.length;i+=4){const r=d[i];d[i]=d[i+1];d[i+1]=r;}
  } else if(type==='blur_ema'){
    for(let py=1;py<H;py++) for(let px=0;px<W;px++){
      const i=(py*W+px)*4, pi=((py-1)*W+px)*4;
      d[i]=d[i]*.7+d[pi]*.3|0; d[i+1]=d[i+1]*.7+d[pi+1]*.3|0; d[i+2]=d[i+2]*.7+d[pi+2]*.3|0;
    }
  } else if(type==='dct_block'){
    const src=new Uint8ClampedArray(d);
    for(let py=0;py<H;py++) for(let px=0;px<W;px++){
      const i=(py*W+px)*4, si=((py&~7)*W+(px&~7))*4;
      d[i]=src[si];d[i+1]=src[si+1];d[i+2]=src[si+2];
    }
  } else if(type==='gamma_skip'){
    for(let i=0;i<d.length;i+=4){
      d[i]=Math.pow(d[i]/255,2.2)*255|0;
      d[i+1]=Math.pow(d[i+1]/255,2.2)*255|0;
      d[i+2]=Math.pow(d[i+2]/255,2.2)*255|0;
    }
  } else if(type==='wb_shift'){
    for(let i=0;i<d.length;i+=4){
      d[i]=Math.max(0,d[i]-40); d[i+2]=Math.min(255,d[i+2]+60);
    }
  }
  ctx.putImageData(img,0,0);
}
"""

# Inject game JS + walkthrough JS before final fit()/draw()
FINAL_INIT = '\nfit(); draw();'
assert FINAL_INIT in html, "fit(); draw(); not found"
html = html.replace(FINAL_INIT, WALKTHROUGH_JS + GAME_JS + '\n\n/* ---- refresh button ---- */\n(function(){\n  const rb=document.getElementById(\'refreshbtn\');\n  if(!rb) return;\n  rb.onclick=function(){rb.textContent=\'⏳\';rb.disabled=true;setTimeout(()=>location.reload(),300);};\n}());\n' + FINAL_INIT, 1)

print("Steps 10-12: walkthrough + game hub JS injected")

# ─────────────────────────────────────────────────────────────────────────────
# WRITE
# ─────────────────────────────────────────────────────────────────────────────
HTML.write_text(html, encoding="utf-8")
print(f"\nDone. File size: {len(html):,} chars")
