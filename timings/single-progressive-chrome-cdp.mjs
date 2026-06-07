#!/usr/bin/env node
/**
 * Spawn real Google Chrome with CDP, run Single Progressive benchmark.
 * Playwright-launched Chrome (even headed) disables wasm thread probe; real Chrome does not.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

const BASE = process.env.BENCH_BASE ?? 'http://localhost:9000';
const PAGE = `${BASE}/web/jxl-single-progressive.html?borders=0`;
const PORT = Number(process.env.CDP_PORT ?? 9333);

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`,
  String.raw`C:\Program Files (x86)\Google\Chrome\Application\chrome.exe`,
].filter(Boolean);

function findChrome() {
  for (const p of CHROME_CANDIDATES) {
    if (existsSync(p)) return p;
  }
  throw new Error(`Chrome not found. Set CHROME_PATH. Tried: ${CHROME_CANDIDATES.join(', ')}`);
}

async function waitCdp(path, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}${path}`);
      if (res.ok) return await res.json();
    } catch { /* retry */ }
    await delay(400);
  }
  throw new Error(`CDP timeout: ${path}`);
}

async function readWasmBaseline(page) {
  return page.evaluate(async () => {
    const { getCapabilities } = await import('@casabio/jxl-capabilities');
    const { detectTier } = await import('@casabio/jxl-wasm');
    const caps = await getCapabilities();
    return {
      crossOriginIsolated: caps.crossOriginIsolated,
      sharedArrayBuffer: caps.sharedArrayBuffer,
      wasmThreads: caps.wasmThreads,
      wasmSimd: caps.wasmSimd,
      wasmRelaxedSimd: caps.wasmRelaxedSimd,
      selectedWasmBuild: caps.selectedWasmBuild,
      facadeDetectTier: detectTier(),
      validateSimd: WebAssembly.validate(new Uint8Array([0,97,115,109,1,0,0,0,1,5,1,96,0,1,123,3,2,1,0,10,8,1,6,0,65,0,253,15,11])),
      validateThreads: WebAssembly.validate(new Uint8Array([0,97,115,109,1,0,0,0,1,4,1,96,0,0,3,2,1,0,5,3,1,3,1,10,11,1,9,0,65,0,254,16,2,0,26,11])),
      ua: navigator.userAgent,
    };
  });
}

async function readMetrics(page) {
  return page.evaluate(() => {
    const text = (id) => document.getElementById(id)?.textContent?.trim() ?? '';
    return {
      passes: text('m-passes'),
      firstMs: text('m-first'),
      finalMs: text('m-final'),
      oneShotMs: text('m-oneshot'),
      speedup: text('m-speedup'),
      encodeMs: text('m-encode'),
      dims: text('m-dims'),
      status: text('single-status'),
    };
  });
}

async function main() {
  const chromePath = findChrome();
  const userDataDir = await mkdtemp(join(tmpdir(), 'sp-real-chrome-'));
  console.log(`Chrome: ${chromePath}`);
  console.log(`CDP port: ${PORT}`);
  console.log(`Profile: ${userDataDir}`);
  console.log(`Page: ${PAGE}`);

  const child = spawn(chromePath, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=TranslateUI',
    PAGE,
  ], { stdio: 'ignore', detached: false });

  let browser = null;
  try {
    const version = await waitCdp('/json/version');
    browser = await chromium.connectOverCDP(version.webSocketDebuggerUrl, { timeout: 120_000 });
    const context = browser.contexts()[0] ?? await browser.newContext();
    let page = context.pages().find((p) => p.url().includes('jxl-single-progressive')) ?? context.pages()[0];
    if (!page) page = await context.newPage();

    page.setDefaultTimeout(0);
    const wasmUrls = [];
    page.on('request', (req) => {
      const u = req.url();
      if (u.includes('jxl-core') && u.endsWith('.wasm')) wasmUrls.push(u);
    });
    page.on('console', (msg) => {
      const t = msg.text();
      if (msg.type() === 'error' || t.includes('WASM baseline') || t.includes('run failed')) {
        console.log(`[browser:${msg.type()}] ${t}`);
      }
    });

    if (!page.url().includes('jxl-single-progressive')) {
      await page.goto(PAGE, { waitUntil: 'networkidle', timeout: 180_000 });
    } else {
      await page.waitForLoadState('networkidle', { timeout: 180_000 }).catch(() => {});
    }

    await page.waitForFunction(
      () => document.getElementById('retrieve-run') && !document.getElementById('retrieve-run').disabled,
      null,
      { timeout: 300_000 },
    );

    let baseline = await readWasmBaseline(page);
    console.log('\nWASM baseline (real Chrome CDP, pre-run):');
    console.log(JSON.stringify(baseline, null, 2));

    await page.selectOption('#size-preset', 'original');
    await page.selectOption('#throttle-rate', '0');
    await page.selectOption('#progressive-detail', 'lastPasses');
    await page.locator('#decode-in-worker').setChecked(true);
    await page.locator('#charts-enabled').setChecked(false);

    console.log('\nRetrieve raw file...');
    const t0 = Date.now();
    await page.locator('#retrieve-run').click();
    await page.waitForFunction(
      () => {
        const s = document.getElementById('single-status')?.textContent ?? '';
        return s.includes('Done.') || s.startsWith('Run failed:') || s.startsWith('Stopped early');
      },
      null,
      { timeout: 600_000 },
    );
    const wallMs = Date.now() - t0;
    const metrics = await readMetrics(page);
    metrics.wallMs = wallMs;
    baseline = await readWasmBaseline(page);

    console.log('\nMetrics:');
    console.log(JSON.stringify(metrics, null, 2));
    console.log('\nWASM files requested:', [...new Set(wasmUrls)]);
    console.log('WASM baseline (post-run):', JSON.stringify(baseline, null, 2));

    const passCount = Number.parseInt(metrics.passes, 10);
    const finalNum = Number.parseFloat(metrics.finalMs);
    const oneShotNum = Number.parseFloat(metrics.oneShotMs);
    const ratio = Number.isFinite(finalNum) && Number.isFinite(oneShotNum) && oneShotNum > 0
      ? (finalNum / oneShotNum).toFixed(2)
      : metrics.speedup;

    console.log('\n=== Real Chrome CDP validation ===');
    const effectiveTier = baseline.facadeDetectTier ?? baseline.selectedWasmBuild;
    console.log(`  tier (capabilities): ${baseline.selectedWasmBuild}`);
    console.log(`  tier (facade/worker): ${effectiveTier}`);
    console.log(`  passes: ${metrics.passes}`);
    console.log(`  first: ${metrics.firstMs}  final: ${metrics.finalMs}  one-shot: ${metrics.oneShotMs}  ratio: ${ratio}×`);
    console.log(`  encode: ${metrics.encodeMs}  wall: ${wallMs} ms`);

    const mtOk = effectiveTier?.includes('-mt') === true || effectiveTier === 'simd-mt' || effectiveTier === 'relaxed-simd-mt';
    const passOk = Number.isFinite(passCount) && passCount >= 2 && passCount <= 4;
    const finalOk = Number.isFinite(finalNum) && finalNum <= 2000;
    console.log(`  simd-mt tier: ${mtOk ? 'PASS' : 'FAIL'}`);
    console.log(`  pass count 2–4: ${passOk ? 'PASS' : 'FAIL'}`);
    console.log(`  final_ms ≤2000: ${finalOk ? 'PASS' : 'FAIL'}`);

    if (metrics.status.startsWith('Run failed')) throw new Error(metrics.status);
    if (!mtOk) process.exitCode = 2;
  } finally {
    try { await browser?.close(); } catch { /* ignore */ }
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});