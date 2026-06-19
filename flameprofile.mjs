// flameprofile.mjs — function-level CPU flame profile of a real browser action, via
// CDP (Chrome DevTools Protocol) sampling profiler. The "marker, time part-to-part"
// view at FUNCTION granularity — no code marks needed. Complements the ablation
// harness (which gives critical-path ceilings): the flame says *which function* burns
// the self-time inside a stage.
//
//   node flameprofile.mjs .flipflop/profiles/<name>.mjs [--size 1024] [--runs 300] [--headed] [--out path]
//
// A profile module exports: name, description, setup?(ctx)→input, action(input, ctx).
// Writes a .cpuprofile artifact (load in DevTools → Performance → "Load profile").
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const SEC = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cross-Origin-Resource-Policy': 'cross-origin' };
const MIME = { '.html': 'text/html', '.mjs': 'application/javascript', '.js': 'application/javascript', '.wasm': 'application/wasm', '.json': 'application/json' };
const ROOT = process.cwd();
function startServer() {
  return new Promise((res) => {
    const srv = http.createServer((req, rep) => {
      const u = new URL(req.url, 'http://localhost');
      if (u.pathname === '/__dom__') { rep.writeHead(200, { ...SEC, 'Content-Type': 'text/html' }); rep.end('<!doctype html><meta charset=utf8><body>'); return; }
      const fp = path.join(ROOT, decodeURIComponent(u.pathname));
      if (!fp.startsWith(ROOT) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) { rep.writeHead(404, SEC); rep.end('nf'); return; }
      rep.writeHead(200, { ...SEC, 'Content-Type': MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream' });
      fs.createReadStream(fp).pipe(rep);
    });
    srv.listen(0, '127.0.0.1', () => res({ srv, port: srv.address().port }));
  });
}

function parseArgs(argv) {
  const o = { size: 1024, runs: 300, headed: false, out: null };
  let file = null;
  for (let i = 0; i < argv.length; i++) { const a = argv[i], next = () => argv[++i];
    if (a === '--size') o.size = +next(); else if (a === '--runs') o.runs = +next();
    else if (a === '--headed') o.headed = true; else if (a === '--out') o.out = next();
    else if (a === '--help' || a === '-h') o.help = true; else if (!a.startsWith('--')) file = a; }
  return { o, file };
}

async function main() {
  const { o, file } = parseArgs(process.argv.slice(2));
  if (o.help || !file) { console.log('Usage: node flameprofile.mjs <profile.mjs> [--size N] [--runs N] [--headed] [--out path]'); if (!file) process.exitCode = 1; return; }
  const { srv, port } = await startServer();
  const base = `http://127.0.0.1:${port}`;
  const profUrl = base + '/' + path.relative(ROOT, path.resolve(file)).replaceAll('\\', '/');
  const { launch } = await import('./tools/launch-browser.mjs');
  const launched = await launch({ headless: !o.headed });
  const page = launched.page;
  try {
    await page.goto(`${base}/__dom__`);
    const meta = await page.evaluate(async (u) => { const m = await import(u); return { name: m.name, description: m.description }; }, profUrl);
    await page.evaluate(async ({ u, size }) => { window.__p = await import(u); window.__pin = window.__p.setup ? await window.__p.setup({ name: 'prof', size, width: size, height: size }) : null; }, { u: profUrl, size: o.size });

    const client = await page.context().newCDPSession(page);
    await client.send('Profiler.enable');
    await client.send('Profiler.setSamplingInterval', { interval: 80 }); // microseconds
    await client.send('Profiler.start');
    await page.evaluate(async (runs) => { const noctx = { mark() {} }; for (let i = 0; i < runs; i++) await window.__p.action(window.__pin, noctx); }, o.runs);
    const { profile } = await client.send('Profiler.stop');

    // self-time per node from samples + timeDeltas
    const nodeById = new Map(profile.nodes.map((n) => [n.id, n]));
    const selfUs = new Map();
    const samples = profile.samples || [], deltas = profile.timeDeltas || [];
    for (let i = 0; i < samples.length; i++) selfUs.set(samples[i], (selfUs.get(samples[i]) || 0) + Math.max(0, deltas[i] || 0));
    const byFn = new Map(); let total = 0;
    for (const [id, us] of selfUs) {
      const n = nodeById.get(id); if (!n) continue;
      const cf = n.callFrame; let fn = cf.functionName || '(anonymous)';
      const file2 = (cf.url || '').split('/').pop() || (cf.url ? cf.url : 'native');
      if (!cf.url && ['(program)', '(idle)', '(garbage collector)', '(root)'].includes(fn) === false && fn === '(anonymous)') fn = '(native)';
      const key = `${fn.padEnd(28)} ${file2}${cf.lineNumber >= 0 ? ':' + (cf.lineNumber + 1) : ''}`;
      byFn.set(key, (byFn.get(key) || 0) + us); total += us;
    }
    const top = [...byFn].sort((a, b) => b[1] - a[1]).slice(0, 22);

    console.log(`\nflameprofile: ${meta.name} — ${o.runs} runs @ size ${o.size}  (${(total / 1000).toFixed(1)} ms sampled self-time)\n`);
    console.log('   self_ms    %    function  @ file:line');
    for (const [key, us] of top) console.log(`  ${(us / 1000).toFixed(2).padStart(8)}  ${((us / total) * 100).toFixed(1).padStart(4)}%  ${key}`);

    const out = o.out || path.join(ROOT, 'docs/outputs/timing tests/flipflop', `${meta.name}.cpuprofile`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(profile));
    console.log(`\n  .cpuprofile → ${path.relative(ROOT, out)}  (DevTools → Performance → Load profile)`);
  } finally { await launched.close().catch(() => {}); srv.close(); }
}

main().catch((e) => { console.error('flameprofile error:', e.stack || e.message); process.exitCode = 1; });
