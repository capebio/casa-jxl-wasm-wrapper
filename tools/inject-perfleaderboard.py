"""inject-perfleaderboard.py
Adds ⚡ perf leaderboard panel to ecosystem-map.html:
- PERF_LOG array (9 entries: 8 David, 1 Jon)
- #perflb slide-up panel wired to ⚡ toolbar button
- renderPerfLb(): sparkline SVG per person, cumulative ms saved,
  hrs/day, changes/hr, memory + file-size win rows, summary footer
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
# 1. CSS for #perflb panel
# ─────────────────────────────────────────────────────────────────────────────
patch(
    '  /* dict tabs */',
    """  /* ── perf leaderboard panel ─────────────────────────────────────── */
  #perflb{
    position:fixed;z-index:30;bottom:0;left:50%;transform:translateX(-50%);
    width:min(780px,98vw);
    background:var(--panel);border:1px solid var(--line);border-bottom:none;
    border-radius:14px 14px 0 0;padding:16px 20px 20px;
    backdrop-filter:blur(8px);
    max-height:70vh;overflow-y:auto;
    display:none;
    box-shadow:0 -4px 32px rgba(0,0,0,.55);
  }
  #perflb.open{ display:block; }
  .plb-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px}
  .plb-title{font-size:15px;font-weight:700;color:#e8f0ff;letter-spacing:-.3px}
  .plb-close{background:none;border:none;color:var(--dim);font-size:18px;cursor:pointer;padding:2px 8px}
  .plb-close:hover{color:#e8f0ff}
  .plb-summary{font-size:11px;color:#89b040;margin-left:auto;margin-right:12px;letter-spacing:.3px}
  .plb-person{margin-bottom:18px;border:1px solid var(--line);border-radius:10px;padding:12px 14px}
  .plb-person-hdr{display:flex;align-items:center;gap:10px;margin-bottom:8px}
  .plb-avatar{width:28px;height:28px;border-radius:50%;font-size:15px;display:flex;align-items:center;justify-content:center;background:var(--line)}
  .plb-pname{font-size:13px;font-weight:600;color:#e0eaff}
  .plb-pstats{font-size:10px;color:var(--dim);margin-left:auto;text-align:right;line-height:1.5}
  .plb-sparkline{margin-left:auto}
  .plb-entries{display:flex;flex-direction:column;gap:4px}
  .plb-entry{display:flex;align-items:center;gap:8px;font-size:11px;padding:4px 6px;border-radius:6px;background:rgba(255,255,255,.03)}
  .plb-entry:hover{background:rgba(255,255,255,.07)}
  .plb-entry-id{font-family:ui-monospace,monospace;color:#4ea1d3;min-width:110px;font-size:10px}
  .plb-entry-desc{color:#9aacbf;flex:1}
  .plb-entry-ms{color:#89b040;min-width:56px;text-align:right;font-family:ui-monospace,monospace;font-size:10px}
  .plb-entry-mem{min-width:48px;text-align:right;font-family:ui-monospace,monospace;font-size:10px}
  .plb-entry-fs{min-width:48px;text-align:right;font-family:ui-monospace,monospace;font-size:10px}
  .plb-entry-date{color:var(--dim);min-width:60px;text-align:right;font-size:9px}
  .mem-pos{color:#c44a4a}.mem-neg{color:#56a854}.fs-neg{color:#56a854}

  /* dict tabs */""",
    'CSS: #perflb panel'
)

# ─────────────────────────────────────────────────────────────────────────────
# 2. HTML: ⚡ toolbar button + #perflb panel element
# ─────────────────────────────────────────────────────────────────────────────
patch(
    '  <button class="btn pointer" id="gamebtn" title="Games — learn &amp; test your knowledge" style="margin-left:4px;font-size:16px">🎮</button>',
    '  <button class="btn pointer" id="gamebtn" title="Games — learn &amp; test your knowledge" style="margin-left:4px;font-size:16px">🎮</button>\n'
    '  <button class="btn pointer" id="perflbbtn" title="Perf leaderboard" style="margin-left:4px;font-size:14px">⚡</button>',
    'HTML: ⚡ toolbar button'
)

PERFLB_HTML = """
<div id="perflb">
  <div class="plb-header">
    <span class="plb-title">⚡ Performance Leaderboard</span>
    <span class="plb-summary" id="plb-summary"></span>
    <button class="plb-close" id="perflb-close">×</button>
  </div>
  <div id="plb-body"></div>
</div>
"""

# Insert before </body>
patch(
    '</body>\n</html>',
    PERFLB_HTML + '\n</body>\n</html>',
    'HTML: #perflb panel element'
)

# ─────────────────────────────────────────────────────────────────────────────
# 3. JS: PERF_LOG data + renderPerfLb() + wiring
# ─────────────────────────────────────────────────────────────────────────────
PERF_JS = r"""
/* ── Perf Leaderboard ──────────────────────────────────────────────────── */
const PERF_LOG = [
  {id:'tone_simd',         who:'David', date:'2026-06-14',
   desc:'AVX2 SIMD tone/LUT apply, wasm128 fallback',
   ratio:33, hrs:8,  msSaved:513, memMB:0,   fileSizePct:null},
  {id:'jxl_o2',            who:'David', date:'2026-06-15',
   desc:'Fix libjxl build: missing /O2 → 30× enc/dec regression reversed',
   ratio:9.5, hrs:3, msSaved:6222, memMB:0,  fileSizePct:null},
  {id:'lut_split',         who:'David', date:'2026-06-19',
   desc:'Split ensure_lut pre/post: tone-drag −65%, WB-drag −35%',
   ratio:2.8, hrs:4,  msSaved:5,   memMB:0,  fileSizePct:null},
  {id:'srgb_eotf',         who:'David', date:'2026-06-19',
   desc:'sRGB EOTF: per-entry powf → OnceLock lerp (91% faster build)',
   ratio:10.7, hrs:2, msSaved:14,  memMB:0,  fileSizePct:null},
  {id:'framestats_fusion', who:'David', date:'2026-06-19',
   desc:'Fused frame-stats + RGB histogram (single RGBA8 pass, −26% BW)',
   ratio:1.36, hrs:4, msSaved:14,  memMB:-6, fileSizePct:null},
  {id:'downscale_recip',   who:'David', date:'2026-06-19',
   desc:'Integer downscale: divide → precomputed reciprocal multiply',
   ratio:1.13, hrs:2, msSaved:6,   memMB:0,  fileSizePct:null},
  {id:'dc_progressive',    who:'Jon',   date:'2026-06-10',
   desc:'DC-first progressive decode: visible frame in first ~2% of bytes',
   ratio:2.5, hrs:20, msSaved:1560, memMB:0, fileSizePct:-58},
  {id:'decoder_pool',      who:'David', date:'2026-06-19',
   desc:'4-decoder LRU pool: skip ~40ms init on rapid multi-image loads',
   ratio:1.0, hrs:5,  msSaved:90,  memMB:+8, fileSizePct:null},
  {id:'tone_matrix_fusion',who:'David', date:'2026-06-19',
   desc:'Fused colour matrix × saturation (M\'=S·M) in scalar + SIMD paths',
   ratio:1.5, hrs:3,  msSaved:12,  memMB:0,  fileSizePct:null},
];

function renderPerfLb(){
  const body=document.getElementById('plb-body');
  const sumEl=document.getElementById('plb-summary');
  if(!body) return;

  const byPerson={};
  for(const e of PERF_LOG){
    if(!byPerson[e.who]) byPerson[e.who]=[];
    byPerson[e.who].push(e);
  }

  let totalMs=0, totalHrs=0;
  PERF_LOG.forEach(e=>{ totalMs+=e.msSaved||0; totalHrs+=e.hrs||0; });
  if(sumEl) sumEl.textContent=
    `−${(totalMs/1000).toFixed(1)}s pipeline · ⏱ ${totalHrs}h total`;

  let html2='';
  for(const [who, entries] of Object.entries(byPerson)){
    entries.sort((a,b)=>a.date.localeCompare(b.date));
    const pMs=entries.reduce((s,e)=>s+(e.msSaved||0),0);
    const pHrs=entries.reduce((s,e)=>s+(e.hrs||0),0);
    const dates=entries.map(e=>e.date);
    const dStart=dates[0], dEnd=dates[dates.length-1];
    const daySpan=Math.max(1,(new Date(dEnd)-new Date(dStart))/(1000*86400)+1);
    const hpd=(pHrs/daySpan).toFixed(1);
    const cph=(pHrs>0?(entries.length/pHrs).toFixed(2):'—');

    // Sparkline (ratio values)
    const ratios=entries.map(e=>e.ratio||1);
    const rMax=Math.max(...ratios, 1.5);
    const SW=80, SH=24;
    const pts=ratios.map((r,i)=>{
      const x=Math.round(i*(SW-4)/(Math.max(ratios.length-1,1)))+2;
      const y=Math.round(SH-4-(r-1)/(rMax-1+.001)*(SH-8))+2;
      return x+','+y;
    }).join(' ');
    const sparkline=`<svg width="${SW}" height="${SH}" style="overflow:visible">
      <polyline points="${pts}" fill="none" stroke="#89b040" stroke-width="1.5" stroke-linejoin="round"/>
      ${ratios.map((r,i)=>{
        const x=Math.round(i*(SW-4)/(Math.max(ratios.length-1,1)))+2;
        const y=Math.round(SH-4-(r-1)/(rMax-1+.001)*(SH-8))+2;
        return `<circle cx="${x}" cy="${y}" r="2.5" fill="#89b040"/>`;
      }).join('')}
    </svg>`;

    html2+=`<div class="plb-person">
      <div class="plb-person-hdr">
        <span class="plb-avatar">${who[0]}</span>
        <span class="plb-pname">${who}</span>
        <span class="plb-pstats">
          −${(pMs/1000).toFixed(2)}s saved · ${pHrs}h · ${hpd}h/day · ${cph} wins/hr
        </span>
        <span class="plb-sparkline">${sparkline}</span>
      </div>
      <div class="plb-entries">`;

    for(const e of entries){
      const msTag=e.msSaved?`<span class="plb-entry-ms">−${e.msSaved}ms</span>`:'<span class="plb-entry-ms" style="color:var(--dim)">—</span>';
      const memTag=e.memMB!==0&&e.memMB!=null
        ?`<span class="plb-entry-mem ${e.memMB>0?'mem-pos':'mem-neg'}">${e.memMB>0?'+':''}${e.memMB}MB</span>`
        :'<span class="plb-entry-mem" style="color:var(--dim)">—</span>';
      const fsTag=e.fileSizePct!=null
        ?`<span class="plb-entry-fs fs-neg">${e.fileSizePct}%</span>`
        :'<span class="plb-entry-fs" style="color:var(--dim)">—</span>';
      html2+=`<div class="plb-entry">
          <span class="plb-entry-id">${e.id}</span>
          <span class="plb-entry-desc">${e.desc}</span>
          ${msTag}${memTag}${fsTag}
          <span class="plb-entry-date">${e.date.slice(5)}</span>
        </div>`;
    }
    html2+='</div></div>';
  }
  body.innerHTML=html2;
}

(function(){
  document.addEventListener('DOMContentLoaded',function(){
    const btn=document.getElementById('perflbbtn');
    const panel=document.getElementById('perflb');
    const cls=document.getElementById('perflb-close');
    if(!btn||!panel) return;
    btn.onclick=function(){
      const open=panel.classList.toggle('open');
      if(open) renderPerfLb();
    };
    if(cls) cls.onclick=function(){ panel.classList.remove('open'); };
    panel.addEventListener('click',function(e){ if(e.target===panel) panel.classList.remove('open'); });
  });
}());
/* ── end Perf Leaderboard ──────────────────────────────────────────────── */
"""

# Insert JS before the closing </script> of the main script block
# The main script ends before the wt-overlay HTML. Find last </script> before </body>
# Use a unique anchor near the end of the snake JS section
patch(
    '// Shift bottom HUD items when snake is open',
    PERF_JS.lstrip('\n') + '\n// Shift bottom HUD items when snake is open',
    'JS: PERF_LOG + renderPerfLb + wiring'
)

# ─────────────────────────────────────────────────────────────────────────────
with open('docs/ecosystem-map.html', 'w', encoding='utf-8') as f:
    f.write(html)

print(f'\nDone. {len(html):,} chars ({len(html)-orig:+,})')
