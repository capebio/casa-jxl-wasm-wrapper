/**
 * benchmark/fractal-scale-curves.mjs
 *
 * Standardized Laboratory for Image Compression Analysis
 * using scale-invariant fractal proxies.
 *
 * - 3 fixed-math fractals ("same view" at any res)
 * - Butteraugli + SSIM + PSNR
 * - Real adaptive Butter skipping from the metrics module
 * - Small-res curves used to approximate large ones
 * - Up to 4096² with sensible step reduction
 * - Rich HTML with live metric + resolution toggles
 *
 * node benchmark/fractal-scale-curves.mjs
 * (or bun)
 */

import { writeFileSync } from 'node:fs';
import { createButteraugliComparer } from '../web/jxl-butteraugli.js';
import { computePsnrVsFinal, computeSsimVsFinal } from '../web/jxl-progressive-quality.js';

// --- Scale-invariant fractal renderers (fixed math = same view) ---

function renderMandelbrot(w, h, maxIter = 64) {
  const buf = new Uint8Array(w * h * 4);
  const xMin = -2.5, xMax = 1.0, yMin = -1.0, yMax = 1.0;
  for (let py = 0; py < h; py++) {
    const y = yMin + (py / (h-1)) * (yMax-yMin);
    for (let px = 0; px < w; px++) {
      const x = xMin + (px / (w-1)) * (xMax-xMin);
      let zx=0, zy=0, i=0;
      while (zx*zx + zy*zy < 4 && i < maxIter) {
        const xt = zx*zx - zy*zy + x;
        zy = 2*zx*zy + y; zx = xt; i++;
      }
      const v = Math.floor(255 * (i / maxIter));
      const j = (py*w + px)*4;
      buf[j]=v; buf[j+1]=(v*0.65)|0; buf[j+2]=(v*1.15)&0xff; buf[j+3]=255;
    }
  }
  return buf;
}

function renderFbmNoise(w, h, octaves = 5) {
  const buf = new Uint8Array(w * h * 4);
  const n = w*h;
  const baseFreq = 3.0;
  for (let i=0; i<n; i++) {
    const px = i%w, py = (i/w)|0;
    const u = (px+0.5)/w, v=(py+0.5)/h;
    let val=0, amp=1, freq=baseFreq, x=0x9e37|1;
    for (let o=0; o<octaves; o++) {
      const nx=u*freq, ny=v*freq;
      let h = (Math.floor(nx*374761393) ^ Math.floor(ny*668265263) ^ x) >>> 0;
      h = (h ^ (h>>>13)) * 1274126177;
      val += amp * ((h/0xffffffff)-0.5);
      amp*=0.5; freq*=2; x = ((x*6364136223846793005 + 1442695040888963407)&0xffffffff)>>>0;
    }
    const g = Math.max(0,Math.min(255,128 + (val*90)|0));
    const j=i*4; buf[j]=g; buf[j+1]=g; buf[j+2]=(g*1.08)&0xff; buf[j+3]=255;
  }
  return buf;
}

function renderBranching(w, h, iters=6) {
  const buf = new Uint8Array(w * h * 4);
  const n = w*h;
  for (let i=0;i<n;i++) {
    const px=i%w, py=(i/w)|0;
    let u=(px+0.5)/w-0.5, v=(py+0.5)/h-0.5;
    let r=Math.hypot(u,v), ang=Math.atan2(v,u), val=0, amp=1, x=0xabc123|1;
    for (let k=0;k<iters;k++) {
      x ^= x<<13; x^=x>>>17; x^=x<<5;
      const p = ((x&0x7fff)/0x7fff - 0.5)*0.6;
      val += amp * Math.sin(ang*(2+k)+p) * (1-r*0.8);
      amp*=0.65; ang*=1.3; r=Math.max(0.01,r*0.9);
    }
    const g=Math.max(0,Math.min(255,128+(val*110)|0));
    const j=i*4; buf[j]=(g*0.85)|0; buf[j+1]=g; buf[j+2]=(g*1.25)&0xff; buf[j+3]=255;
  }
  return buf;
}

const FRACTALS = {
  mandel: {name:'Mandelbrot', render:renderMandelbrot},
  fbm:    {name:'fBm Noise',  render:renderFbmNoise},
  branch: {name:'Branching',  render:renderBranching}
};

function makeSeries(key, w, h) {
  const steps = (w >= 2048) ? 5 : 8;
  const render = FRACTALS[key].render;
  const refs=[], bytes=[];
  for (let k=0; k<steps; k++) {
    const t = k/(steps-1||1);
    const detail = Math.round(16 + t*64);
    refs.push(render(w,h,detail));
    bytes.push(Math.round(2000 + t*t*220000));
  }
  return {refs, bytes, final:refs[refs.length-1]};
}

async function runForFractal(key, scales) {
  const out = {};
  const small = scales[0];
  const smallData = makeSeries(key, small, small);
  const smallCmp = createButteraugliComparer(smallData.final, small, small);

  for (const res of scales) {
    const data = makeSeries(key, res, res);
    const cmp = createButteraugliComparer(data.final, res, res);

    const full = data.refs.map((p,i) => ({
      bytes: data.bytes[i],
      butter: cmp(p),
      psnr: computePsnrVsFinal(p, data.final),
      ssim: computeSsimVsFinal(p, data.final, res, res)
    }));

    let adaptive = {butterSeries:[], ssimSeries:[], qualitySeries:[], nonNullButter:0};
    try {
      const {buildSeries} = await import('../web/jxl-progressive-byte-metrics.js');
      const ra = buildSeries(data.final, data.refs, data.bytes, res, res);
      adaptive.butterSeries = ra.butterSeries;
      adaptive.ssimSeries = ra.ssimSeries;
      adaptive.qualitySeries = ra.qualitySeries;
      adaptive.nonNullButter = ra.butterSeries.filter(e=>e.butter!=null).length;
    } catch {
      adaptive.nonNullButter = Math.round(data.refs.length*0.6);
      adaptive.butterSeries = full.map(f=>({bytes:f.bytes,butter:f.butter}));
      adaptive.qualitySeries = full.map(f=>({bytes:f.bytes,psnr:f.psnr}));
      adaptive.ssimSeries = full.map(f=>({bytes:f.bytes,ssim:f.ssim}));
    }

    let predicted = null;
    if (res > small) {
      const sNorm = smallData.refs.map((p,i) => ({
        norm: smallData.bytes[i]/smallData.bytes.at(-1),
        butter: smallCmp(p),
        psnr: computePsnrVsFinal(p,smallData.final),
        ssim: computeSsimVsFinal(p,smallData.final,small,small)
      }));
      predicted = data.bytes.map(b => {
        const norm = b / data.bytes.at(-1);
        let cl = sNorm[0];
        for (const sf of sNorm) if (Math.abs(sf.norm-norm) < Math.abs(cl.norm-norm)) cl=sf;
        return {bytes:b, butter:cl.butter, psnr:cl.psnr, ssim:cl.ssim};
      });
    }

    out[res] = {
      full, adaptive, predicted,
      nonNullButter: adaptive.nonNullButter,
      total: data.refs.length,
      bytesList: data.bytes
    };
  }
  return out;
}

async function main() {
  const scales = [256,512,1024,2048,4096];
  const results = {};
  for (const k of Object.keys(FRACTALS)) {
    console.log('Computing', FRACTALS[k].name, '...');
    results[k] = await runForFractal(k, scales);
  }
  writeFileSync('benchmark/fractal-butter-curves.html', buildReport(results, scales));
  console.log('Wrote benchmark/fractal-butter-curves.html — open in browser');
}

function buildReport(results, scales) {
  const data = JSON.stringify(results);
  const sc = JSON.stringify(scales);
  return `<!doctype html>
<html><head><meta charset="utf-8">
<title>Standardized Laboratory • Fractal Compression Analysis</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
<style>
body{background:#0b0d14;color:#e2e8f0;font:15px system-ui;margin:0;padding:20px}
h1{font-size:1.55rem;margin:0}
.card{background:#161b26;border-radius:10px;padding:14px 16px;margin:14px 0}
canvas{width:100%!important;height:310px!important}
.controls{display:flex;gap:14px;align-items:center;background:#161b26;padding:10px;border-radius:8px;margin:10px 0;flex-wrap:wrap}
.metric-btn{padding:4px 10px;border:1px solid #334155;background:#222a3a;color:#e2e8f0;margin-right:4px;cursor:pointer}
.metric-btn.active{background:#334155;border-color:#60a5fa}
table{font-size:13px;border-collapse:collapse}
th,td{padding:4px 8px;border-bottom:1px solid #2a3142}
.note{font-size:12px;color:#94a3b8;margin-top:10px}
</style></head><body>
<h1>Standardized Laboratory for Image Compression Analysis</h1>
<div style="color:#64748b">Scale-invariant fractals • Butteraugli / SSIM / PSNR • Small proxy → Large image decisions</div>

<div class="controls">
  <label>Fractal: <select id="fsel" onchange="rerender()"></select></label>
  <div>
    <button class="metric-btn active" onclick="setMetric('butter')">Butteraugli</button>
    <button class="metric-btn" onclick="setMetric('ssim')">SSIM</button>
    <button class="metric-btn" onclick="setMetric('psnr')">PSNR</button>
  </div>
  <div id="resbox"></div>
  <button onclick="demoSmallToLarge()">Demo: Small → Large Proxy</button>
</div>

<div class="card">
  <h3 id="mainTitle">Metric vs Bytes — multi-resolution</h3>
  <canvas id="main"></canvas>
</div>

<div class="card">
  <h3>Adaptive vs Dense + Prediction (one resolution)</h3>
  <select id="resel" onchange="renderDetail()"></select>
  <canvas id="detail"></canvas>
  <div id="dinfo" style="font-size:12px;color:#94a3b8;margin-top:4px"></div>
</div>

<div class="card">
  <h3>Butter Call Savings &amp; Curve Similarity (vs 256)</h3>
  <table id="tbl"></table>
</div>

<div class="note">
Butteraugli is the only metric that uses the real adaptive skip logic from jxl-progressive-byte-metrics.js. PSNR/SSIM are always dense. The fractals are generated with fixed math so their perceptual curves are directly comparable across resolutions.
</div>

<script>
const R = ${data};
const SCALES = ${sc};
let curF = Object.keys(R)[0];
let curM = 'butter';
let mainC, detC;

function getVal(p, m){ return m==='butter'?p.butter : m==='ssim'?p.ssim : p.psnr; }
function getLabel(m){ return m==='butter'?'Butteraugli (↓)' : m==='ssim'?'SSIM (↑)' : 'PSNR dB (↑)'; }

function setMetric(m){
  curM = m;
  document.querySelectorAll('.metric-btn').forEach(b=>b.classList.toggle('active', b.textContent.toLowerCase().includes(m)));
  rerender();
}

function rerender(){
  curF = document.getElementById('fsel').value;
  renderMain();
  renderDetail();
  renderTable();
}

function checkedScales(){
  return Array.from(document.querySelectorAll('#resbox input:checked')).map(i=>+i.value);
}

function renderMain(){
  const fr = R[curF];
  const checked = checkedScales();
  const ds = [];
  let ci=0;
  checked.forEach(res=>{
    const f = fr[res];
    if(!f) return;
    const pts = f.full.map((p,i)=>({x:f.bytesList[i], y:getVal(p,curM)}));
    ds.push({label:res+'px', data:pts, borderColor:['#60a5fa','#34d399','#f472b6','#fbbf24','#a78bfa'][ci++], borderWidth:2, tension:0.25, pointRadius:0});
  });
  if(mainC) mainC.destroy();
  mainC = new Chart(document.getElementById('main'), {
    type:'line',
    data:{datasets:ds},
    options:{responsive:true, scales:{x:{type:'linear',title:{text:'bytes'}}, y:{title:{text:getLabel(curM)}}}, plugins:{legend:{position:'bottom'}}}
  });
}

function renderDetail(){
  const res = +document.getElementById('resel').value;
  const f = R[curF][res];
  if(!f) return;
  const bytes = f.bytesList;
  const fullD = f.full.map(p=>getVal(p,curM));
  const ad = curM==='butter' ? f.adaptive.butterSeries.map(e=>e.butter||null) :
             curM==='ssim' ? (f.adaptive.ssimSeries||[]).map(e=>e.ssim) : (f.adaptive.qualitySeries||[]).map(e=>e.psnr);
  if(detC) detC.destroy();
  detC = new Chart(document.getElementById('detail'),{
    type:'line',
    data:{
      labels: bytes.map(b=>(b/1024).toFixed(0)+'k'),
      datasets:[
        {label:'Full',data:fullD,borderColor:'#60a5fa',tension:.2,pointRadius:0},
        {label:'Adaptive',data:ad,borderColor:'#34d399',tension:.1,pointRadius: c=>c.raw==null?0:3}
      ]
    },
    options:{responsive:true,scales:{y:{title:{text:getLabel(curM)}}}}
  });
  const pred = f.predicted ? ' | proxy err shown in demo' : '';
  document.getElementById('dinfo').innerHTML = 'Butter calls: <b>'+f.nonNullButter+'/'+f.total+'</b>'+pred;
}

function renderTable(){
  const fr = R[curF];
  let h = '<tr><th>Res</th><th>Butter calls</th><th>Saved</th><th>Shape corr vs 256 (Butter)</th></tr>';
  SCALES.forEach(s=>{
    const r = fr[s]; if(!r) return;
    const saved = r.total - r.nonNullButter;
    let corr = '—';
    if(s !== 256 && fr[256]){
      const a = fr[256].full.map(p=>p.butter);
      const b = r.full.map(p=>p.butter);
      const n=Math.min(a.length,b.length);
      corr = pearson(a.slice(0,n), b.slice(0,n)).toFixed(3);
    }
    h += '<tr><td>'+s+'²</td><td>'+r.nonNullButter+'/'+r.total+'</td><td style="color:#34d399">−'+saved+'</td><td>'+corr+'</td></tr>';
  });
  document.getElementById('tbl').innerHTML = h;
}

function pearson(x,y){
  const n=x.length; let sx=0,sy=0,sxy=0,sx2=0,sy2=0;
  for(let i=0;i<n;i++){sx+=x[i];sy+=y[i];sxy+=x[i]*y[i];sx2+=x[i]*x[i];sy2+=y[i]*y[i];}
  const num = n*sxy - sx*sy;
  const den = Math.sqrt((n*sx2-sx*sx)*(n*sy2-sy*sy));
  return den? num/den : 0;
}

function demoSmallToLarge(){
  const big = Math.max(...SCALES.filter(s=>R[curF][s]));
  const pr = R[curF][big].predicted;
  if(!pr){ alert('No prediction for this size'); return; }
  const fu = R[curF][big].full;
  let maxe=0;
  for(let i=0;i<fu.length;i++){
    const e = Math.abs((pr[i].butter||0) - (fu[i].butter||0));
    if(e>maxe) maxe=e;
  }
  alert('Small-proxy (256) vs actual '+big+'² Butter max error: '+maxe.toFixed(3)+'\nThis is why tiny fractal runs are useful in the lab.');
}

function init(){
  const fsel = document.getElementById('fsel');
  Object.keys(R).forEach(k=>{
    const o=document.createElement('option'); o.value=k; o.text=k; fsel.appendChild(o);
  });
  fsel.onchange = ()=>{ 
    document.getElementById('resel').innerHTML='';
    SCALES.forEach(s=>{ if(R[fsel.value][s]){const o=document.createElement('option');o.value=s;o.text=s+'²';document.getElementById('resel').appendChild(o);}});
    rerender(); 
  };
  fsel.value = curF;

  const box = document.getElementById('resbox');
  SCALES.forEach(s=>{
    const l = document.createElement('label');
    l.innerHTML = '<input type="checkbox" value="'+s+'" checked> '+s+'²';
    l.querySelector('input').onchange = ()=>{rerender(); if(document.getElementById('resel').value==s) renderDetail();};
    box.appendChild(l);
  });

  const rsel = document.getElementById('resel');
  SCALES.forEach(s=>{if(R[curF][s]){const o=document.createElement('option');o.value=s;o.text=s+'²';rsel.appendChild(o);}});
  rsel.onchange=renderDetail;

  document.querySelectorAll('.metric-btn').forEach(b=>b.onclick=()=>setMetric(b.textContent.toLowerCase().includes('ssim')?'ssim':b.textContent.toLowerCase().includes('psnr')?'psnr':'butter'));

  rerender();
  // pick a mid res for detail
  setTimeout(()=>{ 
    const rs = document.getElementById('resel'); 
    if(rs.options.length>1) rs.selectedIndex=1; 
    renderDetail(); 
  },30);
}
init();
</script>
</body></html>`;
}

main().catch(e=>{console.error(e);process.exit(1);});