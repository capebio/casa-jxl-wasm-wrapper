"""Inject red egg-timer "currently being worked on" indicator into ecosystem-map.html"""
import sys
sys.stdout.reconfigure(encoding='utf-8')

with open('docs/ecosystem-map.html', encoding='utf-8') as f:
    html = f.read()

# ─────────────────────────────────────────────────────────────────────────────
# 1.  drawWorkingIndicators() — after _updateHeatUI
# ─────────────────────────────────────────────────────────────────────────────
AFTER_ANCHOR = """function _updateHeatUI(){
  const d = document.getElementById('hp-date');
  const s = document.getElementById('hp-slider');
  const p = document.getElementById('hp-play');
  if(d) d.textContent = HEATMAP_DATA.dates[heatIdx];
  if(s) s.value = heatIdx;
  if(p) p.innerHTML = heatPlaying ? '&#9646;&#9646;' : '&#9654;';
}"""

INDICATOR_FN = """
function drawWorkingIndicators(now){
  // Draw a red egg-timer on nodes that have git activity on the exact current heat-player date.
  // Position: mid-upper centre of the node — halfway between the label text and the top edge.
  const cutoff = HEATMAP_DATA.dates[heatIdx];
  // Alternate ⏳ ↔ ⌛ every ~750 ms to simulate a flipping hourglass
  const flipped = (now / 750 | 0) % 2 === 0;
  const glyph = flipped ? '\\u23F3' : '\\u231B'; // ⏳ / ⌛
  const pulse = 0.72 + 0.28 * Math.sin(now / 380);

  for(const [nid, dm] of Object.entries(HEATMAP_DATA.nodes)){
    if(!dm[cutoff]) continue;          // no activity on this exact date
    const rr = renderedSet.get(nid);   // {node, sx, sy, sw, sh, ...} — null if off-screen
    if(!rr) continue;
    const {sx, sy, sw, sh} = rr;
    if(sw < 26 || sh < 14) continue;  // node too small to see at this zoom

    // Centre horizontally; place ~8 % from top (above the label text ≈ 15 %)
    const cx = sx + sw * 0.5;
    const cy = sy + sh * 0.08 + Math.max(6, sh * 0.04); // midway: edge(0%) ↔ name(~15%)
    const fs = Math.max(9, Math.min(22, sh * 0.20));    // emoji font size

    ctx.save();

    // Red radial glow disc behind the emoji
    const gr = Math.max(fs * 0.9, 8);
    const grd = ctx.createRadialGradient(cx, cy, 0, cx, cy, gr * 1.8);
    grd.addColorStop(0,   'rgba(230,50,10,' + (0.60 * pulse).toFixed(2) + ')');
    grd.addColorStop(0.45,'rgba(200,30, 0,' + (0.38 * pulse).toFixed(2) + ')');
    grd.addColorStop(1,   'rgba(160, 0, 0,0)');
    ctx.fillStyle = grd;
    ctx.beginPath(); ctx.arc(cx, cy, gr * 1.8, 0, 6.2832); ctx.fill();

    // Emoji with red shadow glow
    ctx.font = fs + 'px ui-sans-serif,Arial,sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(255,70,10,0.95)';
    ctx.shadowBlur = 7 + 4 * pulse;
    ctx.globalAlpha = 0.80 + 0.20 * pulse;
    ctx.fillText(glyph, cx, cy);
    ctx.restore();
  }
}"""

assert AFTER_ANCHOR in html, 'Could not find _updateHeatUI anchor'
html = html.replace(AFTER_ANCHOR, AFTER_ANCHOR + '\n' + INDICATOR_FN, 1)

# ─────────────────────────────────────────────────────────────────────────────
# 2.  Call it in draw() — after drawBoxes, before drawEdges
# ─────────────────────────────────────────────────────────────────────────────
OLD_CALL = '    ROOTS.forEach(n=>drawBoxes(n,0));\n    drawEdges();'
NEW_CALL  = '    ROOTS.forEach(n=>drawBoxes(n,0));\n    drawWorkingIndicators(performance.now());\n    drawEdges();'
assert OLD_CALL in html, 'Could not find drawBoxes/drawEdges anchor'
html = html.replace(OLD_CALL, NEW_CALL, 1)

# ─────────────────────────────────────────────────────────────────────────────
# Write & verify
# ─────────────────────────────────────────────────────────────────────────────
with open('docs/ecosystem-map.html', 'w', encoding='utf-8') as f:
    f.write(html)

checks = ['drawWorkingIndicators', '\\u23F3', '\\u231B', 'red radial glow']
for c in checks:
    ok = c in html
    print(f'  {"OK" if ok else "MISSING"}: {c!r}')

print(f'Done. {len(html):,} bytes, {html.count(chr(10))+1} lines')
