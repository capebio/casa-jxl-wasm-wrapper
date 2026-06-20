"""inject-intro-share.py
Adds intro overlay + share button to ecosystem-map.html:
- 4-page alchemist book modal
- Animated mandala SVG (3 rotating rings)
- 90 ember particle system
- Share button → re-opens intro
- Auto-shows on first visit (localStorage intro_seen)
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
# 1. CSS
# ─────────────────────────────────────────────────────────────────────────────
INTRO_CSS = """\
  /* ── intro overlay ─────────────────────────────────────────────────────── */
  #intro-overlay{
    position:fixed;inset:0;z-index:200;
    background:rgba(4,8,16,.82);backdrop-filter:blur(6px);
    display:flex;align-items:center;justify-content:center;
    opacity:0;pointer-events:none;
    transition:opacity .35s;
  }
  #intro-overlay.open{ opacity:1;pointer-events:auto; }

  #intro-book{
    position:relative;
    width:min(640px,94vw);
    height:min(700px,88vh);
    min-height:460px;
    background:#0d1520;
    border:1px solid #2a3a50;
    border-radius:16px;
    overflow:hidden;
    box-shadow:0 8px 60px rgba(0,0,0,.7);
    display:flex;flex-direction:column;
  }

  /* particles canvas behind content */
  #intro-particles{
    position:absolute;inset:0;z-index:0;
    pointer-events:none;
  }

  /* page container */
  #intro-pages{
    position:relative;z-index:1;
    flex:1;
    height:0;
    overflow-y:auto;
    scrollbar-width:thin;
    scrollbar-color:#1e2e40 transparent;
  }
  .intro-page{ display:none; padding:28px 28px 12px; }
  .intro-page.active{ display:block; }

  /* footer nav */
  #intro-footer{
    position:relative;z-index:1;
    display:flex;align-items:center;gap:10px;
    padding:12px 20px;
    border-top:1px solid #1a2a3a;
    background:#0a1018;
    flex-shrink:0;
  }
  .intro-dot{
    width:8px;height:8px;border-radius:50%;
    background:#1e2e40;cursor:pointer;transition:background .2s;
  }
  .intro-dot.active{ background:#4ea1d3; }
  .intro-nav-btn{
    background:none;border:1px solid #2a3a50;
    color:#9aacbf;padding:5px 14px;border-radius:20px;
    font-size:12px;cursor:pointer;transition:border-color .2s,color .2s;
  }
  .intro-nav-btn:hover{ border-color:#4ea1d3;color:#c6d8f0; }
  #intro-skip{
    margin-left:auto;
    background:none;border:none;color:var(--dim);
    font-size:11px;cursor:pointer;padding:4px 8px;
  }
  #intro-skip:hover{ color:#c6d8f0; }

  /* ── page 0: lore ─────────────────────────────────────────────────── */
  .intro-lore-title{
    font-size:22px;font-weight:800;color:#e8f0ff;
    letter-spacing:-.5px;margin-bottom:6px;
  }
  .intro-lore-sub{
    font-size:12px;color:#4ea1d3;letter-spacing:.6px;
    text-transform:uppercase;margin-bottom:20px;
  }
  .intro-lore-body{ font-size:13px;line-height:1.7;color:#9aacbf; }

  /* mandala */
  #intro-mandala-wrap{
    display:flex;justify-content:center;margin:16px 0 8px;
  }
  #intro-mandala-desc{
    text-align:center;font-size:11px;color:#4ea1d3;
    min-height:16px;margin-bottom:4px;
    transition:opacity .2s;
  }

  /* lore nav hint */
  .intro-lore-hint{
    font-size:10px;color:var(--dim);margin-top:16px;letter-spacing:.2px;
  }

  /* ── page 1 & 2: feature / relevance cards ────────────────────────── */
  .intro-page-title{
    font-size:14px;font-weight:700;color:#e8f0ff;letter-spacing:-.2px;
    margin-bottom:4px;
  }
  .intro-page-sub{
    font-size:11px;color:var(--dim);margin-bottom:16px;
  }
  .intro-cards{
    display:grid;grid-template-columns:1fr 1fr;gap:10px;
  }
  .intro-feat,.intro-rel-card{
    background:#0f1c2a;border:1px solid #1e2e40;
    border-radius:10px;padding:10px 12px;
    cursor:pointer;transition:border-color .2s,background .2s;
    overflow:hidden;
  }
  .intro-feat:hover,.intro-rel-card:hover{
    border-color:#2e4a6a;background:#121f30;
  }
  .intro-feat.expanded,.intro-rel-card.expanded{
    border-color:#4ea1d3;background:#0d1926;
  }
  .intro-card-icon{ font-size:20px;margin-bottom:4px; }
  .intro-card-name{
    font-size:11px;font-weight:600;color:#c6d8f0;
    font-family:ui-monospace,monospace;margin-bottom:2px;
  }
  .intro-card-tagline{
    font-size:10px;color:var(--dim);line-height:1.4;
  }
  /* detail (hidden until expanded) */
  .intro-feat-detail,.intro-rel-detail{
    display:none;margin-top:8px;padding-top:8px;
    border-top:1px solid #1e2e40;
  }
  .intro-feat.expanded .intro-feat-detail,
  .intro-rel-card.expanded .intro-rel-detail{
    display:block;
  }
  .ifd-sym{
    display:inline-flex;align-items:center;gap:5px;
    font-size:10px;font-weight:600;margin-bottom:4px;
    font-family:ui-monospace,monospace;
  }
  .ifd-dot{
    width:9px;height:9px;border-radius:50%;flex-shrink:0;
  }
  .ifd-fact{
    font-size:10px;color:#9aacbf;line-height:1.5;margin-bottom:6px;
  }
  .ifd-explore{
    font-size:10px;color:#4ea1d3;text-decoration:none;
    display:inline-block;margin-top:2px;
  }
  .ifd-explore:hover{ text-decoration:underline; }

  /* hints */
  .intro-hint{
    font-size:10px;color:var(--dim);text-align:center;
    margin-top:10px;
  }
"""

patch('  /* dict tabs */', INTRO_CSS + '  /* dict tabs */', 'CSS: intro overlay')

# ─────────────────────────────────────────────────────────────────────────────
# 2. HTML
# ─────────────────────────────────────────────────────────────────────────────
INTRO_HTML = """\
<div id="intro-overlay">
  <div id="intro-book">
    <canvas id="intro-particles"></canvas>

    <div id="intro-pages">

      <!-- Page 0: Lore -->
      <div class="intro-page active" id="ip0">
        <div class="intro-lore-title">CasaBio JXL Ecosystem</div>
        <div class="intro-lore-sub">Interactive Architecture Map</div>
        <div id="intro-mandala-wrap">
          <svg id="intro-mandala" width="170" height="170" viewBox="-85 -85 170 170">
            <!-- ring 0: RAW / decode -->
            <g id="im-ring0" style="transform-origin:center">
              <ellipse rx="76" ry="76" fill="none" stroke="#e0a14a" stroke-width="1.5" stroke-dasharray="8 6" opacity=".5"/>
              <circle cx="76" cy="0" r="5" fill="#e0a14a" opacity=".8"/>
            </g>
            <!-- ring 1: pipeline/tone -->
            <g id="im-ring1" style="transform-origin:center">
              <ellipse rx="52" ry="52" fill="none" stroke="#c46bd6" stroke-width="1.5" stroke-dasharray="6 5" opacity=".55"/>
              <circle cx="52" cy="0" r="4" fill="#c46bd6" opacity=".8"/>
            </g>
            <!-- ring 2: encode/decode -->
            <g id="im-ring2" style="transform-origin:center">
              <ellipse rx="30" ry="30" fill="none" stroke="#4ea1d3" stroke-width="1.5" stroke-dasharray="5 4" opacity=".6"/>
              <circle cx="30" cy="0" r="3.5" fill="#4ea1d3" opacity=".9"/>
            </g>
            <!-- centre -->
            <circle r="10" fill="#1a2a3a"/>
            <text text-anchor="middle" y="4" font-size="9" fill="#c6d8f0" font-family="ui-monospace,monospace">JXL</text>
          </svg>
        </div>
        <div id="intro-mandala-desc"></div>
        <div class="intro-lore-body">
          A living map of every crate, package, and pipeline stage
          that converts <strong style="color:#e0a14a">RAW camera files</strong>
          into <strong style="color:#4ea1d3">streaming JXL images</strong>
          for the web.<br><br>
          Click any <em>ring</em> to name it.
          Navigate with the toolbar, or
          <span style="color:#89b040;cursor:pointer"
            onclick="document.getElementById('intro-overlay').classList.remove('open');
                     document.getElementById('wt-reopen').click()">
            take the guided tour →
          </span>
        </div>
        <div class="intro-lore-hint">Tap <strong>Next</strong> to see what's inside the pipeline.</div>
      </div>

      <!-- Page 1: JXL Features -->
      <div class="intro-page" id="ip1">
        <div class="intro-page-title">Inside the JXL Pipeline</div>
        <div class="intro-page-sub">Click a card to see the map symbol + fun fact</div>
        <div class="intro-cards">

          <div class="intro-feat" data-mapid="enc_rs">
            <div class="intro-card-icon">📉</div>
            <div class="intro-card-name">enc_rs</div>
            <div class="intro-card-tagline">rANS entropy coding + VarDCT</div>
            <div class="intro-feat-detail">
              <div class="ifd-sym"><span class="ifd-dot" style="background:#4ea1d3"></span>blue · Encoder</div>
              <div class="ifd-fact">rANS entropy coding, 12 MP ORF → ~4 MB JXL vs ~11 MB JPEG at equivalent quality.</div>
              <a class="ifd-explore" href="#" onclick="introNavigate('enc_rs');return false">Explore ↗</a>
            </div>
          </div>

          <div class="intro-feat" data-mapid="df_prog">
            <div class="intro-card-icon">⚡</div>
            <div class="intro-card-name">df_prog</div>
            <div class="intro-card-tagline">DC-first progressive decode</div>
            <div class="intro-feat-detail">
              <div class="ifd-sym"><span class="ifd-dot" style="background:#5cc98c"></span>green · Progressive</div>
              <div class="ifd-fact">DC coefficients arrive in first ~2% of file — visible preview before the full download.</div>
              <a class="ifd-explore" href="#" onclick="introNavigate('df_prog');return false">Explore ↗</a>
            </div>
          </div>

          <div class="intro-feat" data-mapid="enc_rs">
            <div class="intro-card-icon">🔬</div>
            <div class="intro-card-name">Butteraugli ΔE</div>
            <div class="intro-card-tagline">Perceptual quality metric</div>
            <div class="intro-feat-detail">
              <div class="ifd-sym"><span class="ifd-dot" style="background:#4ea1d3"></span>blue · Encoder</div>
              <div class="ifd-fact">Butteraugli Δ units not PSNR — models human vision for bit allocation.</div>
              <a class="ifd-explore" href="#" onclick="introNavigate('enc_rs');return false">Explore ↗</a>
            </div>
          </div>

          <div class="intro-feat" data-mapid="web">
            <div class="intro-card-icon">🌍</div>
            <div class="intro-card-name">Web-native</div>
            <div class="intro-card-tagline">ISO/IEC 18181 open standard</div>
            <div class="intro-feat-detail">
              <div class="ifd-sym"><span class="ifd-dot" style="background:#3fb6a8"></span>teal · Browser</div>
              <div class="ifd-fact">ISO/IEC 18181, Chrome ≥110, Safari ≥17 — no plugin needed.</div>
              <a class="ifd-explore" href="#" onclick="introNavigate('web');return false">Explore ↗</a>
            </div>
          </div>

          <div class="intro-feat" data-mapid="p_tone">
            <div class="intro-card-icon">🎨</div>
            <div class="intro-card-name">XYB colour space</div>
            <div class="intro-card-tagline">Human LMS cone model</div>
            <div class="intro-feat-detail">
              <div class="ifd-sym"><span class="ifd-dot" style="background:#c46bd6"></span>purple · Tone</div>
              <div class="ifd-fact">XYB derived from human LMS cones, optimised by Butteraugli for bit allocation across frequencies.</div>
              <a class="ifd-explore" href="#" onclick="introNavigate('p_tone');return false">Explore ↗</a>
            </div>
          </div>

        </div>
        <div class="intro-hint">Click a card to reveal its map symbol + fact</div>
      </div>

      <!-- Page 2: Casabio Relevance -->
      <div class="intro-page" id="ip2">
        <div class="intro-page-title">Why CasaBio uses JXL</div>
        <div class="intro-page-sub">Biodiversity imagery from field to browser</div>
        <div class="intro-cards">

          <div class="intro-rel-card" data-mapid="we_process">
            <div class="intro-card-icon">🌿</div>
            <div class="intro-card-name">raw</div>
            <div class="intro-card-tagline">ORF / CR2 / DNG field capture</div>
            <div class="intro-rel-detail">
              <div class="ifd-sym"><span class="ifd-dot" style="background:#e0a14a"></span>amber · RAW</div>
              <div class="ifd-fact">ORF/CR2/DNG with EXIF+GPS embedded in JXL container — georeference survives every transcode.</div>
              <a class="ifd-explore" href="#" onclick="introNavigate('we_process');return false">Explore ↗</a>
            </div>
          </div>

          <div class="intro-rel-card" data-mapid="p_tone">
            <div class="intro-card-icon">🎨</div>
            <div class="intro-card-name">p_tone</div>
            <div class="intro-card-tagline">AVX2 SIMD tone pipeline</div>
            <div class="intro-rel-detail">
              <div class="ifd-sym"><span class="ifd-dot" style="background:#c46bd6"></span>purple · Tone</div>
              <div class="ifd-fact">AVX2 33× faster kernel. LUT split −65% per slider drag. Accurate colours for species ID.</div>
              <a class="ifd-explore" href="#" onclick="introNavigate('p_tone');return false">Explore ↗</a>
            </div>
          </div>

          <div class="intro-rel-card" data-mapid="jxl_cache">
            <div class="intro-card-icon">💾</div>
            <div class="intro-card-name">jxl_cache</div>
            <div class="intro-card-tagline">OPFS persistent cache</div>
            <div class="intro-rel-detail">
              <div class="ifd-sym"><span class="ifd-dot" style="background:#3fb6a8"></span>teal · Cache</div>
              <div class="ifd-fact">OPFS origin-private storage. FNV-1a hash 98.7% faster than SHA-256 — field-ready offline.</div>
              <a class="ifd-explore" href="#" onclick="introNavigate('jxl_cache');return false">Explore ↗</a>
            </div>
          </div>

          <div class="intro-rel-card" data-mapid="jxl_worker">
            <div class="intro-card-icon">🔌</div>
            <div class="intro-card-name">jxl_worker</div>
            <div class="intro-card-tagline">libjxl WASM in Worker</div>
            <div class="intro-rel-detail">
              <div class="ifd-sym"><span class="ifd-dot" style="background:#3fb6a8"></span>teal · Worker</div>
              <div class="ifd-fact">libjxl compiled to WASM (~6 MB cached). Decodes in background thread — UI stays smooth.</div>
              <a class="ifd-explore" href="#" onclick="introNavigate('jxl_worker');return false">Explore ↗</a>
            </div>
          </div>

          <div class="intro-rel-card" data-mapid="we_process">
            <div class="intro-card-icon">🔭</div>
            <div class="intro-card-name">we_process</div>
            <div class="intro-card-tagline">24 MP in ~260 ms (AVX2)</div>
            <div class="intro-rel-detail">
              <div class="ifd-sym"><span class="ifd-dot" style="background:#d3654e"></span>orange · WASM</div>
              <div class="ifd-fact">Full RAW decode + tone in ~260 ms on AVX2. WASM single-thread ~850 ms — still usable offline.</div>
              <a class="ifd-explore" href="#" onclick="introNavigate('we_process');return false">Explore ↗</a>
            </div>
          </div>

          <div class="intro-rel-card" data-mapid="exif">
            <div class="intro-card-icon">🧬</div>
            <div class="intro-card-name">exif</div>
            <div class="intro-card-tagline">Darwin Core + GPS metadata</div>
            <div class="intro-rel-detail">
              <div class="ifd-sym"><span class="ifd-dot" style="background:#8b94a6"></span>grey · Metadata</div>
              <div class="ifd-fact">Darwin Core + EXIF survive binary-identical JXL round-trip — species, location, observer intact.</div>
              <a class="ifd-explore" href="#" onclick="introNavigate('exif');return false">Explore ↗</a>
            </div>
          </div>

        </div>
        <div class="intro-hint">Click a card to reveal its map symbol + fact</div>
      </div>

    </div><!-- /intro-pages -->

    <!-- footer nav -->
    <div id="intro-footer">
      <button class="intro-nav-btn" id="intro-prev">← Prev</button>
      <span id="intro-dots"></span>
      <button class="intro-nav-btn" id="intro-next">Next →</button>
      <button id="intro-skip">Explore map →</button>
    </div>

  </div><!-- /intro-book -->
</div><!-- /intro-overlay -->
"""

patch(
    '</body>\n</html>',
    INTRO_HTML + '\n</body>\n</html>',
    'HTML: intro overlay'
)

# Share button in toolbar
patch(
    '  <button class="btn pointer" id="perflbbtn" title="Perf leaderboard" style="margin-left:4px;font-size:14px">⚡</button>',
    '  <button class="btn pointer" id="perflbbtn" title="Perf leaderboard" style="margin-left:4px;font-size:14px">⚡</button>\n'
    '  <button class="btn pointer" id="sharebtn" title="About this map / intro" style="margin-left:4px;font-size:14px">ℹ️</button>',
    'HTML: share/info button'
)

# ─────────────────────────────────────────────────────────────────────────────
# 3. JS
# ─────────────────────────────────────────────────────────────────────────────
INTRO_JS = r"""
/* ── Intro Overlay ─────────────────────────────────────────────────────── */
(function(){
  const PAGES = ['ip0','ip1','ip2'];
  let curPage = 0;

  function showPage(n){
    n = Math.max(0, Math.min(PAGES.length-1, n));
    curPage = n;
    PAGES.forEach((id,i)=>{
      const el=document.getElementById(id);
      if(el) el.classList.toggle('active', i===n);
    });
    const dots=document.querySelectorAll('.intro-dot');
    dots.forEach((d,i)=>d.classList.toggle('active', i===n));
    const prev=document.getElementById('intro-prev');
    const next=document.getElementById('intro-next');
    if(prev) prev.style.opacity = n===0?'.3':'1';
    if(next) next.textContent = n===PAGES.length-1 ? 'Explore map →' : 'Next →';
  }

  function openIntro(){
    const ov=document.getElementById('intro-overlay');
    if(ov){ ov.classList.add('open'); showPage(0); startIntroParticles(); }
  }
  function closeIntro(){
    const ov=document.getElementById('intro-overlay');
    if(ov){ ov.classList.remove('open'); stopIntroParticles(); }
    localStorage.setItem('intro_seen','1');
  }

  function introNavigate(mapId){
    closeIntro();
    setTimeout(function(){
      var n=typeof N!=='undefined'?N.get(mapId):null;
      if(n&&n.rect){ animTo(n.rect.x+n.rect.w/2,n.rect.y+n.rect.h/2,Math.min(8,(W*0.5)/n.rect.w),{slow:true}); selectNode(n); }
    }, 720);
  }
  window.introNavigate = introNavigate;

  /* ── mandala ring labels ──────────────────────────────────────────── */
  const RING_MSG = [
    'Outer ring: RAW decode pipeline — ORF, CR2, DNG sensor data',
    'Middle ring: Tone & colour — white balance, LUT, saturation, SIMD',
    'Inner ring: JXL encode / decode — rANS entropy, progressive DC/AC',
  ];

  document.addEventListener('DOMContentLoaded', function(){
    /* build dots */
    const dotsEl=document.getElementById('intro-dots');
    if(dotsEl){
      dotsEl.innerHTML='';
      PAGES.forEach((_,i)=>{
        const d=document.createElement('span');
        d.className='intro-dot'+(i===0?' active':'');
        d.onclick=()=>showPage(i);
        dotsEl.appendChild(d);
      });
    }

    /* nav buttons */
    const prevBtn=document.getElementById('intro-prev');
    const nextBtn=document.getElementById('intro-next');
    const skipBtn=document.getElementById('intro-skip');
    if(prevBtn) prevBtn.onclick=()=>showPage(curPage-1);
    if(nextBtn) nextBtn.onclick=function(){
      if(curPage===PAGES.length-1) closeIntro();
      else showPage(curPage+1);
    };
    if(skipBtn) skipBtn.onclick=closeIntro;

    /* close on bg click */
    const ov=document.getElementById('intro-overlay');
    if(ov) ov.onclick=function(e){ if(e.target===ov) closeIntro(); };

    /* mandala ring click */
    ['im-ring0','im-ring1','im-ring2'].forEach(function(id,i){
      const ring=document.getElementById(id);
      if(!ring) return;
      ring.style.cursor='pointer';
      ring.addEventListener('click',function(e){
        e.stopPropagation();
        const desc=document.getElementById('intro-mandala-desc');
        if(desc){ desc.textContent=RING_MSG[i]; desc.style.opacity='1'; }
      });
    });

    /* card expand toggle (pages 1 & 2) */
    document.querySelectorAll('.intro-feat,.intro-rel-card').forEach(function(card){
      card.addEventListener('click',function(e){
        if(e.target.closest('.ifd-explore')) return; // let nav link pass
        const wasExpanded=this.classList.contains('expanded');
        // close siblings
        this.closest('.intro-cards').querySelectorAll('.intro-feat,.intro-rel-card').forEach(function(c){
          c.classList.remove('expanded');
        });
        if(!wasExpanded) this.classList.add('expanded');
      });
    });

    /* share / info button */
    const sbtn=document.getElementById('sharebtn');
    if(sbtn) sbtn.onclick=openIntro;

    /* auto-show on first visit */
    if(!localStorage.getItem('intro_seen')){
      setTimeout(openIntro, 600);
    }

    showPage(0);
  });

  /* ── particle system ──────────────────────────────────────────────── */
  let ptRaf=null, particles=[];
  const N_PARTICLES=90;

  function startIntroParticles(){
    const cv=document.getElementById('intro-particles');
    if(!cv) return;
    const bk=document.getElementById('intro-book');
    cv.width=bk?bk.offsetWidth:640;
    cv.height=bk?bk.offsetHeight:700;
    particles=[];
    for(let i=0;i<N_PARTICLES;i++) particles.push(makeParticle(cv,true));
    function tick(){
      ptRaf=requestAnimationFrame(tick);
      const ctx=cv.getContext('2d');
      ctx.clearRect(0,0,cv.width,cv.height);
      for(let i=0;i<particles.length;i++){
        const p=particles[i];
        p.y-=p.vy;
        p.x+=p.vx;
        p.life--;
        if(p.life<=0) { particles[i]=makeParticle(cv,false); continue; }
        const a=Math.min(1,p.life/40)*p.alpha;
        ctx.beginPath();
        ctx.arc(p.x,p.y,p.r,0,6.283);
        ctx.fillStyle=`rgba(${p.r2},${p.g2},${p.b2},${a})`;
        ctx.fill();
      }
    }
    ptRaf=requestAnimationFrame(tick);
  }
  function stopIntroParticles(){
    if(ptRaf){ cancelAnimationFrame(ptRaf); ptRaf=null; }
  }
  function makeParticle(cv,init){
    const cols=[[214,122,58],[78,161,211],[140,176,64],[196,107,214]];
    const c=cols[(Math.random()*cols.length)|0];
    return {
      x:Math.random()*cv.width,
      y:init?Math.random()*cv.height:cv.height+4,
      vy:0.3+Math.random()*0.5,
      vx:(Math.random()-.5)*0.4,
      r:1+Math.random()*2,
      r2:c[0],g2:c[1],b2:c[2],
      alpha:0.15+Math.random()*0.35,
      life:60+Math.random()*120,
    };
  }

  /* ── mandala animation ──────────────────────────────────────────── */
  let mandalaRaf=null, mandalaAngle=0;
  function animateMandala(){
    mandalaAngle+=0.3;
    const r0=document.getElementById('im-ring0');
    const r1=document.getElementById('im-ring1');
    const r2=document.getElementById('im-ring2');
    if(r0) r0.setAttribute('transform',`rotate(${mandalaAngle})`);
    if(r1) r1.setAttribute('transform',`rotate(${-mandalaAngle*1.4})`);
    if(r2) r2.setAttribute('transform',`rotate(${mandalaAngle*2.1})`);
    mandalaRaf=requestAnimationFrame(animateMandala);
  }
  document.addEventListener('DOMContentLoaded',function(){
    mandalaRaf=requestAnimationFrame(animateMandala);
  });

}());
/* ── end Intro Overlay ──────────────────────────────────────────────────── */
"""

patch(
    '// Shift bottom HUD items when snake is open',
    INTRO_JS.lstrip('\n') + '\n// Shift bottom HUD items when snake is open',
    'JS: intro overlay'
)

# ─────────────────────────────────────────────────────────────────────────────
with open('docs/ecosystem-map.html', 'w', encoding='utf-8') as f:
    f.write(html)

print(f'\nDone. {len(html):,} chars ({len(html)-orig:+,})')
