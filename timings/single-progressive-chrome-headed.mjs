#!/usr/bin/env node
/**
 * Headed real Chrome — simd-mt WASM validation for Single Progressive.
 * Headless Chrome/Playwright shell lacks wasm threads; headed Chrome channel does not.
 */
import { chromium } from 'playwright';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const BASE = process.env.BENCH_BASE ?? 'http://localhost:9000';
const PAGE = `${BASE}/web/jxl-single-progressive.html?borders=0`;

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

async function readWasmBaseline(page) {
  return page.evaluate(async () => {
    const { getCapabilities } = await import('@casabio/jxl-capabilities');
    const caps = await getCapabilities();
    return {
      crossOriginIsolated: caps.crossOriginIsolated,
      sharedArrayBuffer: caps.sharedArrayBuffer,
      wasmThreads: caps.wasmThreads,
      wasmSimd: caps.wasmSimd,
      wasmRelaxedSimd: caps.wasmRelaxedSimd,
      selectedWasmBuild: caps.selectedWasmBuild,
      ua: navigator.userAgent,
    };
  });
}

async function main() {
  const userDataDir = await mkdtemp(join(tmpdir(), 'sp-chrome-'));
  console.log(`Headed Chrome user-data-dir: ${userDataDir}`);
  console.log(`Page: ${PAGE}`);

  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chrome',
    headless: false,
    viewport: { width: 1440, height: 960 },
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    const page = context.pages()[0] ?? await context.newPage();
    page.setDefaultTimeout(0);

    page.on('console', (msg) => {
      const t = msg.text();
      if (msg.type() === 'error' || t.includes('WASM baseline') || t.includes('run failed')) {
        console.log(`[browser:${msg.type()}] ${t}`);
      }
    });
    page.on('pageerror', (err) => console.error(`[pageerror] ${err.message}`));

    await page.goto(PAGE, { waitUntil: 'networkidle', timeout: 180_000 });
    await page.waitForFunction(
      () => document.getElementById('retrieve-run') && !document.getElementById('retrieve-run').disabled,
      null,
      { timeout: 300_000 },
    );

    const baseline = await readWasmBaseline(page);
    console.log('\nWASM baseline (headed Chrome):');
    console.log(JSON.stringify(baseline, null, 2));

    await page.selectOption('#size-preset', 'original');
    await page.selectOption('#throttle-rate', '0');
    await page.selectOption('#progressive-detail', 'lastPasses');
    await page.locator('#decode-in-worker').setChecked(true);
    await page.locator('#charts-enabled').setChecked(false);

    console.log('\nStarting Retrieve raw file (Original, lastPasses, throttle 0)...');
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

    console.log('\nMetrics:');
    console.log(JSON.stringify(metrics, null, 2));

    const passCount = Number.parseInt(metrics.passes, 10);
    const finalNum = Number.parseFloat(metrics.finalMs);
    const oneShotNum = Number.parseFloat(metrics.oneShotMs);
    const ratio = Number.isFinite(finalNum) && Number.isFinite(oneShotNum) && oneShotNum > 0
      ? (finalNum / oneShotNum).toFixed(2)
      : metrics.speedup;

    console.log('\n=== Headed Chrome validation ===');
    console.log(`  tier: ${baseline.selectedWasmBuild} (threads=${baseline.wasmThreads}, simd=${baseline.wasmSimd})`);
    console.log(`  passes: ${metrics.passes}`);
    console.log(`  first: ${metrics.firstMs}  final: ${metrics.finalMs}  one-shot: ${metrics.oneShotMs}  ratio: ${ratio}×`);
    console.log(`  encode: ${metrics.encodeMs}  wall: ${wallMs} ms`);

    const mtOk = baseline.selectedWasmBuild?.includes('-mt') === true;
    const passOk = Number.isFinite(passCount) && passCount >= 2 && passCount <= 4;
    const finalOk = Number.isFinite(finalNum) && finalNum <= 2000;
    console.log(`  simd-mt tier: ${mtOk ? 'PASS' : 'FAIL'}`);
    console.log(`  pass count 2–4: ${passOk ? 'PASS' : 'FAIL'}`);
    console.log(`  final_ms ≤2000: ${finalOk ? 'PASS' : 'FAIL'}`);

    if (metrics.status.startsWith('Run failed')) throw new Error(metrics.status);
    if (!mtOk) process.exitCode = 2;
  } finally {
    await context.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});