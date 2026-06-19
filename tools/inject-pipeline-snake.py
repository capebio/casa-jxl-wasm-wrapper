"""inject-pipeline-snake.py
Adds the Pipeline Timing Snake visualization below the main canvas.
"""
import sys
sys.stdout.reconfigure(encoding='utf-8')

with open('docs/ecosystem-map.html', encoding='utf-8') as f:
    html = f.read()

orig = len(html)
checks = []

def patch(old, new, label):
    global html
    n = html.count(old)
    assert n == 1, f'{label!r}: found {n}× (need 1)'
    html = html.replace(old, new, 1)
    checks.append(label)

# ─────────────────────────────────────────────────────────────────────────────
# 1. CSS
# ─────────────────────────────────────────────────────────────────────────────
SNAKE_CSS = r"""
  /* ── Pipeline Snake ───────────────────────────────────────── */
  #snakepanel{
    position:fixed;z-index:9;bottom:0;left:0;right:0;height:0;
    background:var(--panel);border-top:1px solid var(--line);
    overflow:hidden;transition:height .35s cubic-bezier(.4,0,.2,1);
    display:flex;flex-direction:column;pointer-events:auto;
  }
  #snakepanel.open{height:46vh;min-height:320px;max-height:560px}
  #snake-bar{
    display:flex;align-items:center;gap:8px;padding:7px 14px 6px;
    border-bottom:1px solid var(--line);flex-shrink:0;
    background:var(--panel);z-index:1;
  }
  #snake-bar .snake-title{font-size:12px;font-weight:600;color:#c6d8f0;
    letter-spacing:.4px;margin-right:6px;white-space:nowrap}
  #snake-bar select,#snake-bar button.sbtn{
    background:#111c30;border:1px solid #243150;color:#9aacbf;
    border-radius:5px;padding:3px 8px;font-size:11px;cursor:pointer;
  }
  #snake-bar button.sbtn:hover,#snake-bar select:hover{border-color:#4ea1d3;color:#e0f0ff}
  #snake-bar button.sbtn.active{background:#1a3060;border-color:#4ea1d3;color:#e0f0ff}
  #snake-bar .snake-legend{display:flex;gap:10px;margin-left:8px;flex-wrap:wrap}
  #snake-bar .sleg{display:flex;align-items:center;gap:4px;font-size:10px;color:var(--dim)}
  #snake-bar .sleg-dot{width:10px;height:10px;border-radius:3px;flex-shrink:0}
  #snake-close{margin-left:auto;background:none;border:none;color:var(--dim);
    font-size:18px;cursor:pointer;padding:0 4px;line-height:1}
  #snake-close:hover{color:#e0f0ff}
  #snake-svg-wrap{flex:1;overflow:hidden;position:relative}
  #snake-svg{width:100%;height:100%;display:block}
  /* probe popup */
  #probepopup{
    position:fixed;z-index:30;width:320px;
    background:#0d1520;border:1px solid #2c4470;border-radius:12px;
    padding:15px 17px;font-size:12px;color:#c6cedd;line-height:1.6;
    display:none;pointer-events:auto;box-shadow:0 12px 40px rgba(0,0,0,.75);
  }
  #probepopup .pp-title{font-size:13px;font-weight:700;color:#e8f0ff;margin-bottom:8px}
  #probepopup .pp-source{font-size:10px;color:#4a6a8a;margin-top:8px;font-style:italic}
  #probepopup .pp-row{display:flex;justify-content:space-between;
    padding:3px 0;border-bottom:1px solid #1a2234}
  #probepopup .pp-row:last-of-type{border:none}
  #probepopup .pp-lbl{color:var(--dim)}
  #probepopup .pp-val{color:#e8f0ff;font-weight:500;font-family:ui-monospace,monospace}
  #probepopup .pp-close{float:right;cursor:pointer;color:var(--dim);
    font-size:14px;margin-top:-2px}
  #probepopup .pp-bar{display:flex;gap:4px;margin:8px 0 4px;height:14px;border-radius:3px;overflow:hidden}
  #probepopup .pp-bar-a{background:#4a6faa}
  #probepopup .pp-bar-b{background:#4aa87a}
  #probepopup .pp-bar-labels{display:flex;justify-content:space-between;
    font-size:10px;color:var(--dim);margin-bottom:6px}
  .snake-hotspot-pulse{animation:snake-pulse 1.8s ease-in-out infinite}
  @keyframes snake-pulse{0%,100%{opacity:.7}50%{opacity:1}}
"""

patch('  /* ---- leaderboard (left of git-heat) ---- */\n',
      SNAKE_CSS + '  /* ---- leaderboard (left of git-heat) ---- */\n',
      'CSS: snake panel')

# ─────────────────────────────────────────────────────────────────────────────
# 2. HTML — snake panel + probe popup
# ─────────────────────────────────────────────────────────────────────────────
SNAKE_HTML = """<div id="snakepanel">
  <div id="snake-bar">
    <span class="snake-title">⏱ Pipeline Timing Snake</span>
    <select id="snake-mp" title="Image resolution (scales timing)">
      <option value="4">4 MP</option>
      <option value="12" selected>12 MP</option>
      <option value="24">24 MP</option>
    </select>
    <button class="sbtn active" id="snake-log" title="Toggle log/linear time scale">log scale</button>
    <button class="sbtn" id="snake-anim" title="Animate data packet through pipeline">▶ animate</button>
    <span class="snake-legend" id="snake-legend-wrap"></span>
    <button id="snake-close" title="Close">×</button>
  </div>
  <div id="snake-svg-wrap">
    <svg id="snake-svg" xmlns="http://www.w3.org/2000/svg"></svg>
  </div>
</div>
<div id="probepopup"></div>
"""

SNAKE_BTN_HTML = """<button class="btn pointer" id="snakebtn" title="Pipeline timing snake">⏱</button>
  """

patch('<button class="btn pointer" id="dictbtn"',
      SNAKE_BTN_HTML + '<button class="btn pointer" id="dictbtn"',
      'HTML: snake toolbar button')

patch('<div id="leaderboard">',
      SNAKE_HTML + '<div id="leaderboard">',
      'HTML: snake panel element')

# ─────────────────────────────────────────────────────────────────────────────
# 3. JS — data + rendering
# ─────────────────────────────────────────────────────────────────────────────
SNAKE_JS = r"""
/* ════════════════════════════════════════════════════════════════════════════
   Pipeline Timing Snake
   ════════════════════════════════════════════════════════════════════════════ */

const SNAKE_SYSTEMS = {
  io:     {label:'File I/O',       col:'#4a90c4', dim:'#1a3050'},
  parse:  {label:'RAW Parser',     col:'#56a854', dim:'#1a3020'},
  tone:   {label:'RAW Pipeline',   col:'#9b59d6', dim:'#2a1a40'},
  enc:    {label:'JXL Encoder',    col:'#d67c3a', dim:'#402010'},
  net:    {label:'Network',        col:'#7a8090', dim:'#202430'},
  dec:    {label:'JXL Decoder',    col:'#3ab5d4', dim:'#103040'},
  browser:{label:'Browser Runtime',col:'#89b040', dim:'#202010'},
};

/* ms values are for 12 MP baseline; scaled proportionally for other sizes */
const SNAKE_STAGES = [
  /* row 0 – RAW decode, left→right */
  {id:'io',         l:'I/O Read',          sym:'📂', sys:'io',    ms12:5,    mem:+10,  row:0},
  {id:'magic',      l:'Format detect',     sym:'λ',  sys:'parse', ms12:0.4,  mem:0,    row:0},
  {id:'exif',       l:'EXIF / IFD parse',  sym:'λ',  sys:'parse', ms12:2,    mem:+0.5, row:0},
  {id:'makernote',  l:'MakerNote',         sym:'λ',  sys:'parse', ms12:1,    mem:0,    row:0},
  {id:'ljpeg',      l:'LJPEG decompress',  sym:'λ',  sys:'parse', ms12:42,   mem:+24,  row:0},
  {id:'blk',        l:'Black/White level', sym:'λ',  sys:'tone',  ms12:3,    mem:0,    row:0},
  {id:'demosaic',   l:'Demosaic (MHC)',    sym:'λ',  sys:'tone',  ms12:90,   mem:+48,  row:0, hot:true},
  {id:'wb',         l:'White balance',     sym:'λ',  sys:'tone',  ms12:8,    mem:0,    row:0},
  {id:'matrix',     l:'Colour matrix',     sym:'λ',  sys:'tone',  ms12:12,   mem:0,    row:0},
  {id:'tone_lut',   l:'Tone LUT',          sym:'λ',  sys:'tone',  ms12:100,  mem:0,    row:0, hot:true},
  {id:'sat',        l:'Saturation',        sym:'λ',  sys:'tone',  ms12:18,   mem:0,    row:0},
  {id:'downscale',  l:'Downscale',         sym:'λ',  sys:'tone',  ms12:20,   mem:-36,  row:0},
  {id:'rgba_out',   l:'→ RGBA8',           sym:'λ',  sys:'tone',  ms12:5,    mem:0,    row:0},

  /* row 1 – JXL encode + transit, right→left (stored L→R, rendered reversed) */
  {id:'jxl_setup',  l:'JXL setup',         sym:'λ',  sys:'enc',   ms12:5,    mem:+2,   row:1},
  {id:'jxl_enc',    l:'JXL Encode',        sym:'λ',  sys:'enc',   ms12:367,  mem:-46,  row:1, hot:true},
  {id:'net_send',   l:'Network / OPFS',    sym:'λ',  sys:'net',   ms12:150,  mem:0,    row:1},
  {id:'fetch',      l:'Fetch stream',      sym:'λ',  sys:'browser',ms12:30,  mem:+2,   row:1},

  /* row 2 – Browser JXL decode, left→right */
  {id:'sched',      l:'Scheduler',         sym:'λ',  sys:'browser',ms12:1,   mem:0,    row:2},
  {id:'wasm_push',  l:'WASM chunk push',   sym:'λ',  sys:'dec',   ms12:10,   mem:+1,   row:2},
  {id:'dc_frame',   l:'DC frame',          sym:'λ',  sys:'dec',   ms12:30,   mem:+48,  row:2},
  {id:'ac_frame',   l:'AC refinement',     sym:'λ',  sys:'dec',   ms12:70,   mem:0,    row:2, hot:true},
  {id:'display',    l:'Canvas display',    sym:'λ',  sys:'browser',ms12:5,   mem:0,    row:2},
];

const SNAKE_PROBES = [
  {id:'p_downscale', stage:'downscale',
   label:'downscale_reciprocal_flip.rs',
   icon:'⚡',
   date:'2026-06-19', branch:'perf/mhc-demosaic-20260619',
   desc:'Integer downscale: 3 divides/pixel → precomputed reciprocal multiply. 4K→819px (5× factor).',
   a_label:'Divide (A)', a_ms:23.5,
   b_label:'Reciprocal (B)', b_ms:20.4,
   speedup:'13.3 %', gate:'≥5 %', status:'PASS',
   source:'crates/raw-pipeline/examples/downscale_reciprocal_flip.rs'},

  {id:'p_tone', stage:'tone_lut',
   label:'tone SIMD vs scalar',
   icon:'⚡',
   date:'2026-06-14', branch:'perf/tone-simd',
   desc:'Scalar tone LUT (process_into) vs SIMD AVX2 (apply_tone_bulk). 24 MP synthetic RGGB. LUT gather is the bottleneck (~20 cycles/pixel for gather vs 1 cycle/pixel for sequential load).',
   a_label:'Scalar (A)', a_ms:942,
   b_label:'SIMD AVX2 (B)', b_ms:429,
   speedup:'2.2×', gate:'≥1.5×', status:'PASS',
   note:'24 MP; scale ÷2 for 12 MP column.',
   source:'crates/raw-pipeline/src/tone_simd.rs'},

  {id:'p_demosaic', stage:'demosaic',
   label:'demosaic_bilinear_flip.rs',
   icon:'⚡',
   date:'2026-06-19', branch:'perf/mhc-demosaic-20260619',
   desc:'MHC demosaic vs bilinear on RGGB pattern. MHC: gradient-corrected 5×5 convolution; bilinear: simple 2×2 average. MHC rejected as 1.40× slower and memory-bound — no SIMD headroom.',
   a_label:'MHC (A)', a_ms:90,
   b_label:'Bilinear (B)', b_ms:64,
   speedup:'1.40× SLOWER', gate:'n/a', status:'REJECT (MHC kept for quality)',
   source:'crates/raw-pipeline/examples/demosaic_bilinear_flip.rs'},

  {id:'p_framestats', stage:'rgba_out',
   label:'frame_stats_flipflop.rs',
   icon:'⚡',
   date:'2026-06-19', branch:'GeneralImprovements19062026',
   desc:'Fused frame-stats + RGB histogram: single RGBA8 pass vs two separate loops. Saves 26.6% bandwidth at 24 MP.',
   a_label:'Two-pass (A)', a_ms:28,
   b_label:'Fused (B)', b_ms:21,
   speedup:'1.36×', gate:'≥1.1×', status:'PASS',
   source:'crates/raw-pipeline/examples/frame_stats_flipflop.rs'},

  {id:'p_jxl_enc', stage:'jxl_enc',
   label:'JXL encode /O2 flag fix',
   icon:'⚡',
   date:'2026-06-18', branch:'main',
   desc:'libjxl 0.11.2 compiled WITHOUT /O2 (cmake-rs × ClangCL FLAG clobber). Fix: add_compile_options /O2 /Ob2 in CMakeLists. Same effort=3 q90 12 MP DNG — 9.5× faster.',
   a_label:'Without /O2 (A)', a_ms:3478,
   b_label:'With /O2 (B)', b_ms:367,
   speedup:'9.5×', gate:'≥2×', status:'PASS',
   source:'docs/libjxl-reroute-benchmarks.md'},

  {id:'p_dc', stage:'dc_frame',
   label:'time-to-first-pixel (4G)',
   icon:'⚡',
   date:'2026-06-19', branch:'main',
   desc:'Progressive decode: DC-only frame (lowest quality, smallest bytes) arrives first. Measured on 4G connection (1.5 Mbps). Subsequent AC passes refine in ~70 ms each.',
   a_label:'No progressive (A)', a_ms:1100,
   b_label:'DC first frame (B)', b_ms:320,
   speedup:'3.4×', gate:'≥2×', status:'PASS (perceived)',
   source:'packages/jxl-worker-browser/src/decode-handler.ts'},
];

/* ─── state ─────────────────────────────────────────────────────────────── */
let snakeOpen=false, snakeLog=true, snakeMp=12;
let snakeAnimating=false, snakeAnimPos=0, snakeAnimRaf=null;
let snakeResizeObs=null;

/* ─── open / close ──────────────────────────────────────────────────────── */
function openSnake(){
  snakeOpen=true;
  document.getElementById('snakepanel').classList.add('open');
  buildSnakeLegend();
  setTimeout(renderSnake,350); // wait for CSS transition
}
function closeSnake(){
  snakeOpen=false;
  document.getElementById('snakepanel').classList.remove('open');
  stopSnakeAnim();
}

function buildSnakeLegend(){
  const w=document.getElementById('snake-legend-wrap');
  if(!w||w.children.length) return;
  let h='';
  for(const[k,s] of Object.entries(SNAKE_SYSTEMS)){
    h+=`<span class="sleg"><span class="sleg-dot" style="background:${s.col}"></span>${s.label}</span>`;
  }
  w.innerHTML=h;
}

/* ─── timing scale ──────────────────────────────────────────────────────── */
function stageMs(st){ return st.ms12*(snakeMp/12); }

function toVisW(ms, totalMs, availW, useLog){
  const MIN_W=28;
  if(!useLog){
    return Math.max(MIN_W, (ms/totalMs)*availW);
  }
  // log scale: map log(ms+1) proportionally
  const lv=Math.log(ms+0.5);
  const lmax=Math.log(totalMs+0.5);
  return Math.max(MIN_W, (lv/lmax)*availW);
}

function rowStages(row){ return SNAKE_STAGES.filter(s=>s.row===row); }

/* ─── SVG render ────────────────────────────────────────────────────────── */
const ROW_H=60, CONN_H=34, MEM_H=68, AXIS_H=22,
      PAD_L=12, PAD_R=12, PAD_T=10;

function renderSnake(){
  const wrap=document.getElementById('snake-svg-wrap');
  const svg=document.getElementById('snake-svg');
  if(!wrap||!svg||!snakeOpen) return;

  const W=wrap.clientWidth||800;
  const avail=W-PAD_L-PAD_R;

  // Per-row: compute stage widths
  const rows=[0,1,2].map(r=>{
    const stages=rowStages(r);
    const totalMs=stages.reduce((s,st)=>s+stageMs(st),0);
    let x=0;
    return stages.map(st=>{
      const w=toVisW(stageMs(st),totalMs,avail,snakeLog);
      const item={st,x,w};
      x+=w; return item;
    });
  });

  // Normalize row widths to fill avail exactly
  for(const row of rows){
    const used=row.reduce((s,r)=>s+r.w,0);
    const scale=avail/used;
    let cx=0;
    for(const r of row){ r.w=Math.max(16,r.w*scale); r.x=cx; cx+=r.w; }
  }

  // Row y positions (row 1 is reversed)
  const rowY=[PAD_T+16, PAD_T+16+ROW_H+CONN_H, PAD_T+16+2*(ROW_H+CONN_H)];
  const memY=rowY[2]+ROW_H+12;
  const axisY=memY+MEM_H+4;
  const totalH=axisY+AXIS_H+8;

  // Build SVG
  let s=`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${totalH}" viewBox="0 0 ${W} ${totalH}">`;
  s+=`<defs>
    <filter id="glow"><feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <filter id="glow2"><feGaussianBlur stdDeviation="5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
  </defs>`;

  // Row labels
  const rowLabels=['RAW Decode →','← JXL Encode + Network','Browser Decode →'];
  for(let r=0;r<3;r++){
    const y=rowY[r];
    s+=`<text x="${PAD_L}" y="${y-3}" font-size="9" fill="#4a6080" font-family="ui-sans-serif,sans-serif" letter-spacing=".8" font-weight="600" text-transform="uppercase">${rowLabels[r]}</text>`;
  }

  // Stage rectangles
  for(let ri=0;ri<3;ri++){
    const y=rowY[ri];
    const rowData=rows[ri];
    // Row 1 is rendered right→left
    const items=ri===1 ? [...rowData].reverse() : rowData;
    for(const {st,x,w} of (ri===1?rows[ri]:rowData)){
      const rx=PAD_L+(ri===1?(avail-x-w):x);
      const sys=SNAKE_SYSTEMS[st.sys]||SNAKE_SYSTEMS.io;
      const col=sys.col, dimCol=sys.dim;
      const isHot=st.hot;

      // Main rect
      s+=`<rect x="${rx}" y="${y}" width="${w}" height="${ROW_H}" rx="6"
            fill="${dimCol}" stroke="${col}" stroke-width="${isHot?'2':'1'}"
            ${isHot?'class="snake-hotspot-pulse"':''} opacity="${isHot?1:.9}"/>`;

      // Hotspot glow
      if(isHot) s+=`<rect x="${rx+1}" y="${y+1}" width="${w-2}" height="${ROW_H-2}" rx="5" fill="${col}" opacity=".06" filter="url(#glow)"/>`;

      // Clip content to rect
      const clipId=`cl_${st.id}`;
      s+=`<clipPath id="${clipId}"><rect x="${rx+2}" y="${y}" width="${w-4}" height="${ROW_H}"/></clipPath>`;
      s+=`<g clip-path="url(#${clipId})">`;

      // Symbol circle
      const sym=st.sym==='λ'?'λ':'?';
      s+=`<circle cx="${rx+14}" cy="${y+18}" r="9" fill="${col}" opacity=".25"/>`;
      s+=`<text x="${rx+14}" y="${y+23}" text-anchor="middle" font-size="10" fill="${col}" font-family="ui-monospace,monospace">${sym}</text>`;

      // Stage label
      const labelX=rx+(w>70?22:w/2);
      const anchor=w>70?'start':'middle';
      if(w>36){
        s+=`<text x="${labelX+(w>70?4:0)}" y="${y+22}" text-anchor="${anchor}"
              font-size="${w>80?11:w>50?10:9}" fill="#c6d8f0"
              font-family="ui-sans-serif,sans-serif" font-weight="500">${escapeHtml(st.l)}</text>`;
      }

      // Timing badge
      const ms=stageMs(st);
      const msStr=ms<1?ms.toFixed(1)+'ms':ms<100?(ms|0)+'ms':(ms|0)+'ms';
      if(w>30){
        s+=`<text x="${rx+w-5}" y="${y+ROW_H-6}" text-anchor="end"
              font-size="9" fill="${col}" opacity=".9" font-family="ui-monospace,monospace">${msStr}</text>`;
      }

      // Memory delta badge
      if(st.mem!==0&&w>50){
        const mc=st.mem>0?'#56a854':'#c44a4a';
        const ms2=st.mem>0?'+'+st.mem:st.mem;
        s+=`<text x="${rx+5}" y="${y+ROW_H-6}" text-anchor="start"
              font-size="9" fill="${mc}" opacity=".85" font-family="ui-monospace,monospace">${ms2}MB</text>`;
      }

      s+='</g>';

      // Stage separator line
      s+=`<line x1="${rx+w-.5}" y1="${y+6}" x2="${rx+w-.5}" y2="${y+ROW_H-6}" stroke="${col}" stroke-width=".5" opacity=".3"/>`;
    }
  }

  // Connectors between rows (rounded corner arcs)
  // Row 0 → Row 1: right side
  {
    const x1=PAD_L+avail, y1=rowY[0]+ROW_H, y2=rowY[1];
    const r=CONN_H/2;
    s+=`<path d="M ${x1-2} ${y1} Q ${x1+r} ${y1} ${x1+r} ${y1+r} L ${x1+r} ${y2-r} Q ${x1+r} ${y2} ${x1-2} ${y2}"
          fill="none" stroke="#4a6080" stroke-width="2" opacity=".5"/>`;
    // Arrow
    s+=`<polygon points="${x1-6},${y2-3} ${x1+2},${y2} ${x1-6},${y2+3}" fill="#4a6080" opacity=".5"/>`;
  }
  // Row 1 → Row 2: left side
  {
    const x1=PAD_L, y1=rowY[1]+ROW_H, y2=rowY[2];
    const r=CONN_H/2;
    s+=`<path d="M ${x1+2} ${y1} Q ${x1-r} ${y1} ${x1-r} ${y1+r} L ${x1-r} ${y2-r} Q ${x1-r} ${y2} ${x1+2} ${y2}"
          fill="none" stroke="#4a6080" stroke-width="2" opacity=".5"/>`;
    s+=`<polygon points="${x1+6},${y2-3} ${x1-2},${y2} ${x1+6},${y2+3}" fill="#4a6080" opacity=".5"/>`;
  }

  // Probe needles
  for(const probe of SNAKE_PROBES){
    const stage=SNAKE_STAGES.find(s=>s.id===probe.stage);
    if(!stage) continue;
    const ri=stage.row;
    const rowData=rows[ri];
    const item=rowData.find(r=>r.st.id===stage.id);
    if(!item) continue;

    let rx=PAD_L+(ri===1?(avail-item.x-item.w):item.x);
    // Probe at right edge of stage (boundary)
    const probeX=rx+item.w-item.w*0.3;
    const probeTopY=rowY[ri]+ROW_H;
    const probeBotY=probeTopY+22;

    // Needle line
    s+=`<line x1="${probeX}" y1="${probeTopY}" x2="${probeX}" y2="${probeBotY}"
          stroke="#f5c518" stroke-width="1.5" opacity=".9"/>`;
    // Probe circle (clickable)
    s+=`<circle cx="${probeX}" cy="${probeBotY}" r="7" fill="#1a1800" stroke="#f5c518" stroke-width="1.5"
          class="snake-probe" data-probe="${probe.id}" style="cursor:pointer" opacity=".95" filter="url(#glow)"/>`;
    // Lightning bolt in circle
    s+=`<text x="${probeX}" y="${probeBotY+4}" text-anchor="middle" font-size="9"
          fill="#f5c518" style="pointer-events:none">⚡</text>`;
    // Small label above needle
    if(item.w>60){
      const shortLbl=probe.label.replace(/\.rs$/,'').slice(-18);
      s+=`<text x="${probeX}" y="${probeTopY-3}" text-anchor="middle"
            font-size="8" fill="#f5c518" opacity=".7" font-family="ui-monospace,monospace">${shortLbl}</text>`;
    }
  }

  // Memory area chart
  {
    const stages=SNAKE_STAGES; // all in row order 0→1→2
    // Compute cumulative memory at each stage boundary
    // We lay them out left→right in pipeline order (row 0, row 1, row 2)
    // but row 1 is physically right→left. For memory chart we just use pipeline order.
    const allStages=[...rowStages(0),...rowStages(1),...rowStages(2)];
    const totalStages=allStages.length;
    let cum=0;
    const pts=[{x:0,m:0}];
    for(const st of allStages){ cum+=st.mem; pts.push({x:pts.length/(totalStages),m:cum}); }

    const maxMem=Math.max(1,...pts.map(p=>p.m));
    const minMem=Math.min(0,...pts.map(p=>p.m));
    const memRange=maxMem-minMem||1;

    function memPx(m){ return memY+MEM_H-4-((m-minMem)/memRange)*(MEM_H-16); }
    function memX(t){ return PAD_L+t*avail; }

    // Zero line
    const zeroY=memPx(0);
    s+=`<line x1="${PAD_L}" y1="${zeroY}" x2="${PAD_L+avail}" y2="${zeroY}"
          stroke="#2a3a50" stroke-width="1" stroke-dasharray="3,4"/>`;

    // Area path
    let aPath=`M ${memX(0)} ${zeroY}`;
    for(const p of pts) aPath+=` L ${memX(p.x)} ${memPx(p.m)}`;
    aPath+=` L ${memX(1)} ${zeroY} Z`;
    s+=`<path d="${aPath}" fill="#3ab5d4" opacity=".18"/>`;

    // Line path
    let lPath=`M ${memX(pts[0].x)} ${memPx(pts[0].m)}`;
    for(const p of pts.slice(1)) lPath+=` L ${memX(p.x)} ${memPx(p.m)}`;
    s+=`<path d="${lPath}" fill="none" stroke="#3ab5d4" stroke-width="1.5" opacity=".7"/>`;

    // Labels
    s+=`<text x="${PAD_L}" y="${memY+9}" font-size="9" fill="#4a6080" font-family="ui-sans-serif,sans-serif" letter-spacing=".5">HEAP MB</text>`;
    s+=`<text x="${PAD_L+avail}" y="${memY+9}" text-anchor="end" font-size="9" fill="#3ab5d4" font-family="ui-monospace,monospace">${maxMem}MB</text>`;
    s+=`<text x="${PAD_L+2}" y="${memPx(maxMem)-3}" font-size="8" fill="#3ab5d4" opacity=".7" font-family="ui-monospace,monospace">▲${maxMem}MB</text>`;

    // Tick at each stage with dot
    for(let i=0;i<pts.length;i++){
      const p=pts[i];
      s+=`<circle cx="${memX(p.x)}" cy="${memPx(p.m)}" r="2.5" fill="#3ab5d4" opacity=".8"/>`;
    }
  }

  // Time axis (per-row, under row 2 only for simplicity)
  {
    const y=axisY;
    s+=`<line x1="${PAD_L}" y1="${y}" x2="${PAD_L+avail}" y2="${y}" stroke="#2a3a50" stroke-width="1"/>`;
    const axisStages=rowStages(2);
    const totalMs=axisStages.reduce((acc,st)=>acc+stageMs(st),0);
    // 5 ticks
    for(let i=0;i<=5;i++){
      const t=i/5;
      const ms=totalMs*t;
      const x=PAD_L+t*avail;
      s+=`<line x1="${x}" y1="${y}" x2="${x}" y2="${y+4}" stroke="#4a6080" stroke-width="1"/>`;
      s+=`<text x="${x}" y="${y+13}" text-anchor="middle" font-size="8"
            fill="#4a6080" font-family="ui-monospace,monospace">${(ms|0)}ms</text>`;
    }
    s+=`<text x="${PAD_L+avail/2}" y="${y+AXIS_H-2}" text-anchor="middle" font-size="8"
          fill="#2a3a50" font-family="ui-sans-serif,sans-serif">Browser decode path (ms, ${snakeMp} MP, ${snakeLog?'log':'linear'} scale)</text>`;
  }

  // Animation packet placeholder (drawn by animateSnake if active)
  if(snakeAnimating){
    const t=snakeAnimPos; // 0..1 across full pipeline
    const stages3=SNAKE_STAGES.length;
    const si=Math.min(stages3-1, (t*stages3)|0);
    const st=SNAKE_STAGES[si];
    const ri=st.row;
    const rowData=rows[ri];
    const item=rowData.find(r=>r.st.id===st.id);
    if(item){
      const within=(t*stages3)%1;
      const rx=PAD_L+(ri===1?(avail-item.x-item.w):item.x);
      const px=ri===1?(rx+item.w-within*item.w):(rx+within*item.w);
      const py=rowY[ri]+ROW_H/2;
      s+=`<circle cx="${px}" cy="${py}" r="7" fill="${SNAKE_SYSTEMS[st.sys].col}" opacity=".9" filter="url(#glow2)"/>`;
      s+=`<circle cx="${px}" cy="${py}" r="4" fill="#ffffff" opacity=".7"/>`;
    }
  }

  s+='</svg>';
  svg.outerHTML=s;  // replace svg element

  // Re-attach probe click handlers on new svg
  const newSvg=document.getElementById('snake-svg-wrap').querySelector('svg');
  if(newSvg){
    newSvg.id='snake-svg';
    newSvg.querySelectorAll('.snake-probe').forEach(el=>{
      el.addEventListener('click',function(e){
        e.stopPropagation();
        const pid=this.dataset.probe;
        openProbePopup(pid,e.clientX,e.clientY);
      });
    });
    // Stage hover tooltip
    newSvg.querySelectorAll('rect[id^="sr_"]').forEach(el=>{
      el.addEventListener('mouseenter',function(e){
        const sid=this.id.slice(3);
        const st=SNAKE_STAGES.find(s=>s.id===sid);
        if(st) showSnakeTooltip(st,e.clientX,e.clientY);
      });
      el.addEventListener('mouseleave',hideSnakeTooltip);
    });
  }
}

/* ─── probe popup ───────────────────────────────────────────────────────── */
function openProbePopup(pid,cx,cy){
  const probe=SNAKE_PROBES.find(p=>p.id===pid);
  if(!probe) return;
  const pop=document.getElementById('probepopup');
  const total=probe.a_ms+probe.b_ms;
  const pctA=((probe.a_ms/total)*100).toFixed(0);
  const pctB=((probe.b_ms/total)*100).toFixed(0);
  const statusCol=probe.status==='PASS'||probe.status.startsWith('PASS')?'#56a854':
                  probe.status.startsWith('REJECT')?'#c46a40':'#c4c040';

  pop.innerHTML=`
    <span class="pp-close" onclick="document.getElementById('probepopup').style.display='none'">×</span>
    <div class="pp-title">⚡ ${escapeHtml(probe.label)}</div>
    <div class="pp-row"><span class="pp-lbl">Date</span><span class="pp-val">${probe.date}</span></div>
    <div class="pp-row"><span class="pp-lbl">Branch</span><span class="pp-val">${probe.branch}</span></div>
    <div class="pp-row"><span class="pp-lbl">Speedup</span><span class="pp-val">${probe.speedup}</span></div>
    <div class="pp-row"><span class="pp-lbl">Gate</span><span class="pp-val">${probe.gate}</span></div>
    <div class="pp-row"><span class="pp-lbl">Status</span><span class="pp-val" style="color:${statusCol}">${probe.status}</span></div>
    <div style="margin:10px 0 4px;font-size:11px;color:#9aacbf">${escapeHtml(probe.desc)}</div>
    <div class="pp-bar">
      <div class="pp-bar-a" style="width:${pctA}%"></div>
      <div class="pp-bar-b" style="width:${pctB}%"></div>
    </div>
    <div class="pp-bar-labels">
      <span>${escapeHtml(probe.a_label)}: ${probe.a_ms}ms</span>
      <span>${escapeHtml(probe.b_label)}: ${probe.b_ms}ms</span>
    </div>
    ${probe.note?`<div style="font-size:10px;color:#4a6a8a;margin-top:2px">${escapeHtml(probe.note)}</div>`:''}
    <div class="pp-source">${escapeHtml(probe.source)}</div>`;

  pop.style.display='block';
  const pr=pop.getBoundingClientRect();
  pop.style.left=Math.min(cx+10,window.innerWidth-pr.width-12)+'px';
  pop.style.top=Math.min(cy-20,window.innerHeight-pr.height-12)+'px';
}

/* ─── animation ────────────────────────────────────────────────────────── */
function startSnakeAnim(){
  snakeAnimating=true; snakeAnimPos=0;
  document.getElementById('snake-anim').textContent='■ stop';
  document.getElementById('snake-anim').classList.add('active');
  function tick(){
    snakeAnimPos=(snakeAnimPos+0.004)%1;
    renderSnake();
    snakeAnimRaf=requestAnimationFrame(tick);
  }
  snakeAnimRaf=requestAnimationFrame(tick);
}
function stopSnakeAnim(){
  snakeAnimating=false;
  if(snakeAnimRaf){ cancelAnimationFrame(snakeAnimRaf); snakeAnimRaf=null; }
  const b=document.getElementById('snake-anim');
  if(b){ b.textContent='▶ animate'; b.classList.remove('active'); }
}

/* ─── wiring ────────────────────────────────────────────────────────────── */
document.getElementById('snakebtn').onclick=function(){
  if(snakeOpen) closeSnake(); else openSnake();
};
document.getElementById('snake-close').onclick=closeSnake;
document.getElementById('snake-log').onclick=function(){
  snakeLog=!snakeLog;
  this.textContent=snakeLog?'log scale':'linear scale';
  this.classList.toggle('active',snakeLog);
  renderSnake();
};
document.getElementById('snake-mp').onchange=function(){
  snakeMp=parseInt(this.value);
  renderSnake();
};
document.getElementById('snake-anim').onclick=function(){
  if(snakeAnimating) stopSnakeAnim(); else startSnakeAnim();
};

// Close probe popup on outside click
document.addEventListener('click',function(e){
  const pop=document.getElementById('probepopup');
  if(pop&&pop.style.display!=='none'&&!pop.contains(e.target)) pop.style.display='none';
});

// Shift bottom HUD items when snake is open
(function(){
  const panel=document.getElementById('snakepanel');
  const obs=new MutationObserver(()=>{
    const h=snakeOpen?panel.getBoundingClientRect().height:0;
    const hstr=h?h+'px':'0px';
    const lb=document.getElementById('leaderboard');
    const hp=document.getElementById('heatplayer');
    if(lb) lb.style.bottom=hstr;
    if(hp) hp.style.bottom=hstr;
  });
  obs.observe(panel,{attributeFilter:['class']});
}());

// Re-render on resize
new ResizeObserver(()=>{ if(snakeOpen) renderSnake(); })
  .observe(document.getElementById('snake-svg-wrap'));
"""

patch('document.getElementById("dictbtn").onclick=openDict;\n',
      'document.getElementById("dictbtn").onclick=openDict;\n' + SNAKE_JS,
      'JS: pipeline snake')

# ─────────────────────────────────────────────────────────────────────────────
# Write
# ─────────────────────────────────────────────────────────────────────────────
with open('docs/ecosystem-map.html', 'w', encoding='utf-8') as f:
    f.write(html)

print(f'Done. {len(html):,} bytes (+{len(html)-orig:,}), {html.count(chr(10))+1} lines')
for c in checks: print(f'  OK: {c}')
