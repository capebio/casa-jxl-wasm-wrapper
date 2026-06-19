"""inject-leaderboard.py
Adds a leaderboard box to the left of #heatplayer showing:
  - Zoom level (larger text)
  - Components in view count
  - 3-tier LOD hierarchy: highest-kind bold/large | mid normal | lower small
Removes zoom+count from zoomlbl (leaves only gen date).
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
# 1.  CSS — leaderboard box + tier styles
# ─────────────────────────────────────────────────────────────────────────────

LB_CSS = """  /* ---- leaderboard (left of git-heat) ---- */
  #leaderboard{
    position:fixed;z-index:8;bottom:0;
    right:calc(50% + 8px);
    transform:translateX(-100%);
    background:var(--panel);border:1px solid var(--line);border-bottom:none;
    border-radius:10px 10px 0 0;padding:10px 18px 12px;
    pointer-events:auto;backdrop-filter:blur(6px);
    min-width:240px;max-width:360px;
  }
  #lb-row1{display:flex;gap:22px;align-items:baseline;margin-bottom:7px}
  .lb-field-label{font-size:10px;text-transform:uppercase;letter-spacing:.7px;
    color:var(--dim);margin-right:4px}
  #lb-zval{font-size:18px;font-weight:700;color:#e8f0ff;letter-spacing:-.5px}
  #lb-cval{font-size:18px;font-weight:700;color:#e8f0ff;letter-spacing:-.5px}
  .lb-divider{height:1px;background:var(--line);margin:6px 0 8px}
  /* tier 0 = highest LOD (system/file) bold large */
  .lb-tier0{font-size:15px;font-weight:700;color:#e8f0ff;
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:4px;
    display:flex;align-items:baseline;gap:5px}
  .lb-tier0 .lb-kind-tag{font-size:9px;font-weight:400;color:#4ea1d3;
    text-transform:uppercase;letter-spacing:.6px;flex-shrink:0}
  /* tier 1 = mid (file/module) normal weight */
  .lb-tier1{font-size:12.5px;font-weight:400;color:#9aacbf;
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:3px;
    display:flex;align-items:baseline;gap:5px}
  .lb-tier1 .lb-kind-tag{font-size:9px;color:#4a6a80;text-transform:uppercase;
    letter-spacing:.6px;flex-shrink:0}
  /* tier 2 = lowest (module/fn) small */
  .lb-tier2{font-size:10.5px;font-weight:400;color:var(--dim);
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
    display:flex;align-items:baseline;gap:5px}
  .lb-tier2 .lb-kind-tag{font-size:9px;color:#334455;text-transform:uppercase;
    letter-spacing:.6px;flex-shrink:0}
"""

patch('  /* dict tabs */\n', LB_CSS + '  /* dict tabs */\n', 'CSS: leaderboard')

# ─────────────────────────────────────────────────────────────────────────────
# 2.  HTML — insert #leaderboard before #heatplayer
# ─────────────────────────────────────────────────────────────────────────────

LB_HTML = """<div id="leaderboard">
  <div id="lb-row1">
    <span><span class="lb-field-label">Zoom</span><span id="lb-zval">—</span></span>
    <span><span class="lb-field-label">In view</span><span id="lb-cval">—</span></span>
  </div>
  <div class="lb-divider"></div>
  <div id="lb-tiers"></div>
</div>
"""

patch('<div id="heatplayer">', LB_HTML + '<div id="heatplayer">', 'HTML: leaderboard element')

# ─────────────────────────────────────────────────────────────────────────────
# 3.  JS — strip zoom/count from zoomlbl; add leaderboard update in updateHud
# ─────────────────────────────────────────────────────────────────────────────

OLD_HUD = (
    'function updateHud(){\n'
    '  // dominant LOD = kind of the largest non-expanded rendered node\n'
    '  let best=null;\n'
    '  rendered.forEach(r=>{ if(!r.expanded){ if(!best||r.sw*r.sh>best.sw*best.sh) best=r; } });\n'
    '  const lvl = best? ({system:"systems",file:"files",module:"modules",fn:"functions",component:"components"}[best.node.k]) : "components";\n'
    '  crumbs.innerHTML = flowSet ? `<b style="color:#c46bd6">tracing ${nameById(flowSrc)}</b>` : "";\n'
    '  zoomlbl.textContent = `${(cam.scale*100/0.2|0)/100}× · ${rendered.length} shown · ${GRAPH.generated?("gen "+GRAPH.generated):"manual"}`;\n'
    '}'
)

NEW_HUD = r"""function updateHud(){
  // dominant LOD = kind of the largest non-expanded rendered node
  let best=null;
  rendered.forEach(r=>{ if(!r.expanded){ if(!best||r.sw*r.sh>best.sw*best.sh) best=r; } });
  crumbs.innerHTML = flowSet ? `<b style="color:#c46bd6">tracing ${nameById(flowSrc)}</b>` : "";
  // gen date only in zoomlbl now
  zoomlbl.textContent = GRAPH.generated ? ("gen "+GRAPH.generated) : "";

  // ── leaderboard ──
  const KIND_ORDER=['system','file','module','fn','component'];
  const KIND_LABEL={system:'Systems',file:'Files',module:'Modules',fn:'Functions',component:'Components'};
  const byKind=new Map();
  rendered.forEach(r=>{
    const k=r.node.k||'component';
    if(!byKind.has(k)) byKind.set(k,[]);
    byKind.get(k).push(r.node.l||r.node.id);
  });
  const tiers=KIND_ORDER.filter(k=>byKind.has(k));
  const zoomVal=(cam.scale*100/0.2|0)/100;

  const lbZ=document.getElementById('lb-zval');
  const lbC=document.getElementById('lb-cval');
  const lbT=document.getElementById('lb-tiers');
  if(lbZ) lbZ.textContent=zoomVal+'×';
  if(lbC) lbC.textContent=rendered.length;
  if(lbT){
    let h='';
    const MAX=[6,8,10]; // max labels per tier
    tiers.forEach((k,i)=>{
      const cls=i===0?'lb-tier0':i===1?'lb-tier1':'lb-tier2';
      if(i>=3) return;
      const labels=byKind.get(k);
      const shown=labels.slice(0,MAX[i]);
      const rest=labels.length-shown.length;
      const names=shown.map(s=>escapeHtml(s)).join(' <span style="opacity:.4">·</span> ')
                  +(rest>0?` <span style="opacity:.5">+${rest}</span>`:'');
      h+=`<div class="${cls}"><span class="lb-kind-tag">${KIND_LABEL[k]}</span>${names}</div>`;
    });
    if(!h) h='<div class="lb-tier2" style="color:var(--dim)">—</div>';
    lbT.innerHTML=h;
  }
}"""

patch(OLD_HUD, NEW_HUD, 'JS: updateHud with leaderboard')

# ─────────────────────────────────────────────────────────────────────────────
# Write
# ─────────────────────────────────────────────────────────────────────────────

with open('docs/ecosystem-map.html', 'w', encoding='utf-8') as f:
    f.write(html)

print(f'Done. {len(html):,} bytes (+{len(html)-original_len:,}), {html.count(chr(10))+1} lines')
for c in checks: print(f'  OK: {c}')
