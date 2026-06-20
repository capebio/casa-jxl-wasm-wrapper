"""inject-snake-v2.py
Upgrades snake to v2:
- SNAKE_STAGES: add mapId, new stages (lut_build, opfs_cache, decode_hdr)
- SNAKE_SYSTEMS: add cache system
- SNAKE_PROBES: add p_lut_build, p_dc
- ROW_H 60→88, font sizes doubled
- Animation: time-proportional (snakeAnimMs + snakeAnimSpeed=0.10)
- Controls: ▶ start / ⏸ pause / ⏹ stop + speed slider + time display
- Click stage → snakeNavigate(mapId)
- snakeNavigate(mapId): close panel + fly to map node
"""
import sys
sys.stdout.reconfigure(encoding='utf-8')

with open('docs/ecosystem-map.html', encoding='utf-8') as f:
    html = f.read()
orig = len(html)

def patch(old, new, label):
    global html
    n = html.count(old)
    assert n == 1, f'{label!r}: {n}x\n  {old[:80]!r}'
    html = html.replace(old, new, 1)
    print(f'  OK: {label}')

# ─────────────────────────────────────────────────────────────────────────────
# 1. SNAKE_SYSTEMS — add cache
# ─────────────────────────────────────────────────────────────────────────────
patch(
    "  net:    {label:'Network',        col:'#7a8090', dim:'#202430'},",
    "  net:    {label:'Network',        col:'#7a8090', dim:'#202430'},\n"
    "  cache:  {label:'OPFS Cache',     col:'#a06030', dim:'#302010'},",
    'SYSTEMS: add cache'
)

# ─────────────────────────────────────────────────────────────────────────────
# 2. Replace SNAKE_STAGES (full slice) with v2 version including mapIds + new stages
# ─────────────────────────────────────────────────────────────────────────────
stages_start = html.find('/* ms values are for 12 MP baseline')
stages_end   = html.find('\nconst SNAKE_PROBES', stages_start)
assert stages_start > 0 and stages_end > stages_start

NEW_STAGES = """\
/* ms values are for 12 MP baseline; scaled proportionally for other sizes.
   mapId = node id in ecosystem-map (click stage → fly to that node) */
const SNAKE_STAGES = [
  /* row 0 – RAW decode, left→right */
  {id:'io',         l:'I/O Read',           sys:'io',    ms12:5,    mem:+10,  row:0, mapId:'we_process'},
  {id:'magic',      l:'Format detect',      sys:'parse', ms12:0.4,  mem:0,    row:0, mapId:'we_process'},
  {id:'exif',       l:'EXIF / IFD parse',   sys:'parse', ms12:2,    mem:+0.5, row:0, mapId:'exif'},
  {id:'makernote',  l:'MakerNote',          sys:'parse', ms12:1,    mem:0,    row:0, mapId:'exif'},
  {id:'ljpeg',      l:'LJPEG decompress',   sys:'parse', ms12:42,   mem:+24,  row:0, mapId:'we_process'},
  {id:'blk',        l:'Black/White level',  sys:'tone',  ms12:3,    mem:0,    row:0, mapId:'we_process'},
  {id:'demosaic',   l:'Demosaic (MHC)',     sys:'tone',  ms12:90,   mem:+48,  row:0, hot:true, mapId:'d_mhc'},
  {id:'wb',         l:'White balance',      sys:'tone',  ms12:8,    mem:0,    row:0, mapId:'p_tone'},
  {id:'matrix',     l:'Colour matrix',      sys:'tone',  ms12:12,   mem:0,    row:0, mapId:'p_tone'},
  {id:'lut_build',  l:'LUT build',          sys:'tone',  ms12:5,    mem:0,    row:0, mapId:'p_tone'},
  {id:'tone_lut',   l:'LUT apply',          sys:'tone',  ms12:95,   mem:0,    row:0, hot:true, mapId:'p_tone'},
  {id:'sat',        l:'Saturation',         sys:'tone',  ms12:18,   mem:0,    row:0, mapId:'p_tone'},
  {id:'downscale',  l:'Downscale',          sys:'tone',  ms12:20,   mem:-36,  row:0, mapId:'we_process'},
  {id:'rgba_out',   l:'→ RGBA8',            sys:'tone',  ms12:5,    mem:0,    row:0, mapId:'we_process'},

  /* row 1 – JXL encode + transit, right→left (stored L→R, rendered reversed) */
  {id:'jxl_setup',  l:'JXL setup',          sys:'enc',   ms12:5,    mem:+2,   row:1, mapId:'enc_rs'},
  {id:'jxl_enc',    l:'JXL encode',         sys:'enc',   ms12:367,  mem:-46,  row:1, hot:true, mapId:'enc_rs'},
  {id:'net_send',   l:'Network',            sys:'net',   ms12:120,  mem:0,    row:1, mapId:'web'},
  {id:'opfs_cache', l:'OPFS write',         sys:'cache', ms12:30,   mem:0,    row:1, mapId:'jxl_cache'},
  {id:'fetch',      l:'Fetch stream',       sys:'browser',ms12:30,  mem:+2,   row:1, mapId:'web'},

  /* row 2 – Browser JXL decode, left→right */
  {id:'decode_hdr', l:'JXL header parse',   sys:'dec',   ms12:5,    mem:+1,   row:2, mapId:'df_prog'},
  {id:'sched',      l:'Scheduler',          sys:'browser',ms12:1,   mem:0,    row:2, mapId:'jxl_worker'},
  {id:'wasm_push',  l:'WASM chunk push',    sys:'dec',   ms12:10,   mem:+1,   row:2, mapId:'jxl_worker'},
  {id:'dc_frame',   l:'DC frame',           sys:'dec',   ms12:30,   mem:+48,  row:2, mapId:'df_prog'},
  {id:'ac_frame',   l:'AC refinement',      sys:'dec',   ms12:70,   mem:0,    row:2, hot:true, mapId:'df_prog'},
  {id:'display',    l:'Canvas display',     sys:'browser',ms12:5,   mem:0,    row:2, mapId:'web'},
];\
"""

html = html[:stages_start] + NEW_STAGES + html[stages_end:]
print('  OK: SNAKE_STAGES v2 (with mapId + new stages)')

# ─────────────────────────────────────────────────────────────────────────────
# 3. SNAKE_PROBES — add p_lut_build before existing probes
# ─────────────────────────────────────────────────────────────────────────────
patch(
    "  {id:'p_downscale', stage:'downscale',",
    """  {id:'p_lut_build',stage:'lut_build',
   label:'LUT split + sRGB EOTF lerp',
   icon:'⚡',
   date:'2026-06-19', branch:'GeneralImprovements19062026',
   desc:'Split ensure_lut pre/post phases (−65% tone-drag, −35% WB-drag). sRGB EOTF: per-entry powf → OnceLock lerp (91% faster).',
   a_label:'Full rebuild (A)', a_ms:7.5,
   b_label:'Split+EOTF (B)', b_ms:0.7,
   speedup:'10.7×', gate:'≥2×', status:'PASS',
   source:'crates/raw-pipeline/src/pipeline.rs'},

  {id:'p_downscale', stage:'downscale',""",
    'PROBES: add p_lut_build'
)

# ─────────────────────────────────────────────────────────────────────────────
# 4. ROW_H 60 → 88 (bigger stages)
# ─────────────────────────────────────────────────────────────────────────────
patch(
    'const ROW_H=60, CONN_H=34, MEM_H=68, AXIS_H=22,',
    'const ROW_H=88, CONN_H=44, MEM_H=88, AXIS_H=28,',
    'ROW_H 60→88'
)

# ─────────────────────────────────────────────────────────────────────────────
# 5. SVG render: sym always λ, fix y coords for taller rows, fix sizes + broken badge
# ─────────────────────────────────────────────────────────────────────────────
patch(
    "      const sym=st.sym==='λ'?'λ':'?';\n"
    "      s+=`<circle cx=\"${rx+14}\" cy=\"${y+18}\" r=\"9\" fill=\"${col}\" opacity=\".25\"/>`;\n"
    "      s+=`<text x=\"${rx+14}\" y=\"${y+23}\" text-anchor=\"middle\" font-size=\"10\" fill=\"${col}\" font-family=\"ui-monospace,monospace\">${sym}</text>`;",

    "      const sym='λ';\n"
    "      s+=`<circle cx=\"${rx+14}\" cy=\"${y+26}\" r=\"11\" fill=\"${col}\" opacity=\".25\"/>`;\n"
    "      s+=`<text x=\"${rx+14}\" y=\"${y+31}\" text-anchor=\"middle\" font-size=\"13\" fill=\"${col}\" font-family=\"ui-monospace,monospace\">${sym}</text>`;",
    'SVG: sym always λ + y coords for ROW_H=88'
)
patch(
    '        s+=`<text x="${labelX+(w>70?4:0)}" y="${y+22}" text-anchor="${anchor}"\n'
    '              font-size="${w>80?11:w>50?10:9}" fill="#c6d8f0"\n'
    '              font-family="ui-sans-serif,sans-serif" font-weight="500">${escapeHtml(st.l)}</text>`;',

    '        s+=`<text x="${labelX+(w>70?4:0)}" y="${y+34}" text-anchor="${anchor}"\n'
    '              font-size="${w>80?13:w>50?12:10}" fill="#c6d8f0"\n'
    '              font-family="ui-sans-serif,sans-serif" font-weight="500">${escapeHtml(st.l)}</text>`;',
    'SVG: label y+22→y+34, font 11→13'
)
patch(
    '        s+=`<text x="${rx+w-5}" y="${y+ROW_H-6}" text-anchor="end"\n'
    '              font-size="12" fill="${col}" opacity=".9" font-family="ui-monospace,monospace">${msStr}</text>`;',

    '        s+=`<text x="${rx+w-5}" y="${y+ROW_H-8}" text-anchor="end"\n'
    '              font-size="14" fill="${col}" opacity=".9" font-family="ui-monospace,monospace">${msStr}</text>`;',
    'SVG: timing badge font-size 12→14'
)
patch(
    '        s+=`<text x="${rx+5}" y="${y+ROW_H-6}" text-anchor="start"\n'
    '              112" opacity=".85" font-family="ui-monospace,monospace">${ms2}MB</text>`;',

    '        s+=`<text x="${rx+5}" y="${y+ROW_H-8}" text-anchor="start"\n'
    '              font-size="11" fill="${mc}" opacity=".85" font-family="ui-monospace,monospace">${ms2}MB</text>`;',
    'SVG: fix broken memory badge (missing font-size/fill)'
)

# ─────────────────────────────────────────────────────────────────────────────
# 6. Animation state — add v2 vars
# ─────────────────────────────────────────────────────────────────────────────
patch(
    'let snakeOpen=false, snakeLog=true, snakeMp=12;\n'
    'let snakeAnimating=false, snakeAnimPos=0, snakeAnimRaf=null;\n'
    'let snakeResizeObs=null;',

    'let snakeOpen=false, snakeLog=true, snakeMp=12;\n'
    'let snakeAnimating=false, snakeAnimPaused=false, snakeAnimRaf=null;\n'
    'let snakeAnimMs=0, snakeAnimSpeed=0.10, snakeAnimLastT=null;\n'
    'let snakeResizeObs=null;\n'
    '\n'
    'function animTotalMs(){\n'
    '  return [0,1,2].map(r=>SNAKE_STAGES.filter(s=>s.row===r).reduce((s,st)=>s+stageMs(st),0)).reduce((a,b)=>a+b,0);\n'
    '}\n'
    'function animDotPos(ms){\n'
    '  const all=[...SNAKE_STAGES.filter(s=>s.row===0),...SNAKE_STAGES.filter(s=>s.row===1),...SNAKE_STAGES.filter(s=>s.row===2)];\n'
    '  const total=all.reduce((s,st)=>s+stageMs(st),0);\n'
    '  let t=((ms%total)+total)%total;\n'
    '  for(const st of all){ const m=stageMs(st); if(t<=m) return {stage:st,within:t/m}; t-=m; }\n'
    '  return {stage:all[all.length-1],within:1};\n'
    '}\n'
    'function snakeNavigate(mapId){\n'
    '  if(!mapId) return;\n'
    '  closeSnake();\n'
    '  setTimeout(function(){\n'
    '    var n=typeof N!==\'undefined\'?N.get(mapId):null;\n'
    '    if(n&&n.rect){ animTo(n.rect.x+n.rect.w/2,n.rect.y+n.rect.h/2,Math.min(8,(W*0.5)/n.rect.w),{slow:true}); selectNode(n); }\n'
    '  },720);\n'
    '}\n'
    'function snakeNavigateStage(sid){\n'
    '  const st=SNAKE_STAGES.find(s=>s.id===sid);\n'
    '  if(st&&st.mapId) snakeNavigate(st.mapId);\n'
    '}',
    'JS: v2 state vars + animTotalMs + animDotPos + snakeNavigate'
)

# ─────────────────────────────────────────────────────────────────────────────
# 7. Replace dot rendering (snakeAnimPos → snakeAnimMs)
# ─────────────────────────────────────────────────────────────────────────────
patch(
    '  if(snakeAnimating){\n'
    '    const t=snakeAnimPos; // 0..1 across full pipeline\n'
    '    const stages3=SNAKE_STAGES.length;\n'
    '    const si=Math.min(stages3-1, (t*stages3)|0);\n'
    '    const st=SNAKE_STAGES[si];\n'
    '    const ri=st.row;\n'
    '    const rowData=rows[ri];\n'
    '    const item=rowData.find(r=>r.st.id===st.id);\n'
    '    if(item){\n'
    '      const within=(t*stages3)%1;\n'
    '      const rx=PAD_L+(ri===1?(avail-item.x-item.w):item.x);\n'
    '      const px=ri===1?(rx+item.w-within*item.w):(rx+within*item.w);\n'
    '      const py=rowY[ri]+ROW_H/2;\n'
    '      s+=`<circle cx="${px}" cy="${py}" r="7" fill="${SNAKE_SYSTEMS[st.sys].col}" opacity=".9" filter="url(#glow2)"/>`;\n'
    '      s+=`<circle cx="${px}" cy="${py}" r="4" fill="#ffffff" opacity=".7"/>`;\n'
    '    }\n'
    '  }',

    '  if(snakeAnimating){\n'
    '    const dp=animDotPos(snakeAnimMs);\n'
    '    if(dp){\n'
    '      const st=dp.stage; const ri=st.row;\n'
    '      const rowData=rows[ri];\n'
    '      const item=rowData.find(r=>r.st.id===st.id);\n'
    '      if(item){\n'
    '        const within=dp.within;\n'
    '        const rx=PAD_L+(ri===1?(avail-item.x-item.w):item.x);\n'
    '        const px=ri===1?(rx+item.w-within*item.w):(rx+within*item.w);\n'
    '        const py=rowY[ri]+ROW_H/2;\n'
    '        s+=`<circle cx="${px}" cy="${py}" r="9" fill="${SNAKE_SYSTEMS[st.sys].col}" opacity=".9" filter="url(#glow2)"/>`;\n'
    '        s+=`<circle cx="${px}" cy="${py}" r="5" fill="#ffffff" opacity=".75"/>`;\n'
    '      }\n'
    '    }\n'
    '  }',
    'JS: dot rendering → animDotPos(snakeAnimMs)'
)

# ─────────────────────────────────────────────────────────────────────────────
# 8. Add stage click-to-navigate in the probe/hover wiring section
# ─────────────────────────────────────────────────────────────────────────────
patch(
    "    // Stage hover tooltip\n"
    "    newSvg.querySelectorAll('rect[id^=\"sr_\"]').forEach(el=>{",
    "    // Stage click → navigate to map node\n"
    "    newSvg.querySelectorAll('rect[id^=\"sr_\"]').forEach(el=>{\n"
    "      el.addEventListener('click',function(e){\n"
    "        e.stopPropagation();\n"
    "        const sid=this.id.slice(3);\n"
    "        snakeNavigateStage(sid);\n"
    "      });\n"
    "    });\n"
    "    // Stage hover tooltip\n"
    "    newSvg.querySelectorAll('rect[id^=\"sr_\"]').forEach(el=>{",
    'JS: stage click → navigate'
)

# ─────────────────────────────────────────────────────────────────────────────
# 9. Replace startSnakeAnim + stopSnakeAnim with v2 versions
# ─────────────────────────────────────────────────────────────────────────────
patch(
    'function startSnakeAnim(){\n'
    '  snakeAnimating=true; snakeAnimPos=0;\n'
    "  document.getElementById('snake-anim').textContent='■ stop';\n"
    "  document.getElementById('snake-anim').classList.add('active');\n"
    '  function tick(){\n'
    '    snakeAnimPos=(snakeAnimPos+0.004)%1;\n'
    '    renderSnake();\n'
    '    snakeAnimRaf=requestAnimationFrame(tick);\n'
    '  }\n'
    '  snakeAnimRaf=requestAnimationFrame(tick);\n'
    '}\n'
    'function stopSnakeAnim(){\n'
    '  snakeAnimating=false;\n'
    '  if(snakeAnimRaf){ cancelAnimationFrame(snakeAnimRaf); snakeAnimRaf=null; }\n'
    "  const b=document.getElementById('snake-anim');\n"
    "  if(b){ b.textContent='▶ animate'; b.classList.remove('active'); }\n"
    '}',

    'function startSnakeAnim(){\n'
    '  if(snakeAnimating&&!snakeAnimPaused) return;\n'
    '  if(snakeAnimPaused){ snakeAnimPaused=false; \n'
    "    const pb=document.getElementById('snake-pause'); if(pb) pb.textContent='⏸'; return;\n"
    '  }\n'
    '  snakeAnimating=true; snakeAnimPaused=false; snakeAnimLastT=null;\n'
    '  if(snakeAnimMs>=animTotalMs()) snakeAnimMs=0;\n'
    "  const ab=document.getElementById('snake-anim');\n"
    "  if(ab){ ab.textContent='⏹'; ab.classList.add('active'); }\n"
    '  function tick(t){\n'
    '    if(!snakeAnimating) return;\n'
    '    if(!snakeAnimPaused){\n'
    '      if(snakeAnimLastT!==null) snakeAnimMs+=(t-snakeAnimLastT)*snakeAnimSpeed;\n'
    '      snakeAnimLastT=t;\n'
    '      if(snakeAnimMs>=animTotalMs()) snakeAnimMs=0;\n'
    '    } else { snakeAnimLastT=t; }\n'
    "    const td=document.getElementById('snake-time-disp');\n"
    '    if(td) td.textContent=snakeAnimMs.toFixed(0)+(snakeMp===12?\'ms\':\'ms @\'+snakeMp+\'MP\');\n'
    '    renderSnake();\n'
    '    snakeAnimRaf=requestAnimationFrame(tick);\n'
    '  }\n'
    '  snakeAnimRaf=requestAnimationFrame(tick);\n'
    '}\n'
    'function pauseSnakeAnim(){\n'
    '  if(!snakeAnimating) return;\n'
    '  snakeAnimPaused=!snakeAnimPaused;\n'
    "  const pb=document.getElementById('snake-pause');\n"
    "  if(pb) pb.textContent=snakeAnimPaused?'▶':'⏸';\n"
    '}\n'
    'function stopSnakeAnim(){\n'
    '  snakeAnimating=false; snakeAnimPaused=false; snakeAnimMs=0; snakeAnimLastT=null;\n'
    '  if(snakeAnimRaf){ cancelAnimationFrame(snakeAnimRaf); snakeAnimRaf=null; }\n'
    "  const ab=document.getElementById('snake-anim'); if(ab){ ab.textContent='▶'; ab.classList.remove('active'); }\n"
    "  const pb=document.getElementById('snake-pause'); if(pb) pb.textContent='⏸';\n"
    "  const td=document.getElementById('snake-time-disp'); if(td) td.textContent='—';\n"
    '  renderSnake();\n'
    '}\n'
    'function updateSpeedFromSlider(){\n'
    "  const sl=document.getElementById('snake-speed-sl');\n"
    "  const lbl=document.getElementById('snake-speed-lbl');\n"
    '  if(!sl) return;\n'
    '  snakeAnimSpeed=Math.pow(10,(parseFloat(sl.value)-100)/100);\n'
    "  if(lbl) lbl.textContent='×'+snakeAnimSpeed.toFixed(snakeAnimSpeed<0.1?3:2);\n"
    '}',
    'JS: v2 startSnakeAnim + pauseSnakeAnim + stopSnakeAnim + updateSpeedFromSlider'
)

# ─────────────────────────────────────────────────────────────────────────────
# 10. Wire new controls (after existing wiring)
# ─────────────────────────────────────────────────────────────────────────────
patch(
    "document.getElementById('snake-anim').onclick=function(){\n"
    "  if(snakeAnimating) stopSnakeAnim(); else startSnakeAnim();\n"
    '};',

    "document.getElementById('snake-anim').onclick=function(){\n"
    "  if(snakeAnimating) stopSnakeAnim(); else startSnakeAnim();\n"
    '};\n'
    "(function(){\n"
    "  const pb=document.getElementById('snake-pause');\n"
    "  if(pb) pb.onclick=pauseSnakeAnim;\n"
    "  const sl=document.getElementById('snake-speed-sl');\n"
    "  if(sl){ sl.oninput=updateSpeedFromSlider; updateSpeedFromSlider(); }\n"
    '}());',
    'JS: wire pause + speed slider'
)

# ─────────────────────────────────────────────────────────────────────────────
# 11. Upgrade snake bar HTML controls
# ─────────────────────────────────────────────────────────────────────────────
patch(
    '    <button class="sbtn" id="snake-anim">▶ animate</button>\n'
    '    <div class="snake-legend">\n'
    '      <div id="snake-legend-wrap"></div>\n'
    '    </div>\n'
    '    <button id="snake-close">×</button>',

    '    <button class="sbtn" id="snake-anim" title="Start / stop">▶</button>\n'
    '    <button class="sbtn" id="snake-pause" title="Pause / resume">⏸</button>\n'
    '    <span style="display:flex;align-items:center;gap:4px;font-size:11px">\n'
    '      <input type="range" id="snake-speed-sl" min="0" max="200" value="50"\n'
    '        style="width:54px;accent-color:#d67c3a" title="Animation speed">\n'
    '      <span id="snake-speed-lbl" style="min-width:34px;color:#d67c3a">×0.10</span>\n'
    '    </span>\n'
    '    <span id="snake-time-disp" style="font-size:11px;color:#89b040;min-width:44px">—</span>\n'
    '    <div class="snake-legend">\n'
    '      <div id="snake-legend-wrap"></div>\n'
    '    </div>\n'
    '    <button id="snake-close">×</button>',
    'HTML: snake bar controls v2'
)

# ─────────────────────────────────────────────────────────────────────────────
with open('docs/ecosystem-map.html', 'w', encoding='utf-8') as f:
    f.write(html)

print(f'\nDone. {len(html):,} chars ({len(html)-orig:+,})')
