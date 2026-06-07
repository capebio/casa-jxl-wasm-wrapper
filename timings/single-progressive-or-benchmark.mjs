#!/usr/bin/env node
/**
 * Headless benchmark: Single Progressive @ Original, throttle 0.
 * Compares lastPasses (product default) vs passes (diagnostic).
 */
import { chromium } from 'playwright';

const BROWSER_PATH = process.env.BROWSER_PATH
  ?? String.raw`C:\Users\User\AppData\Local\ms-playwright\chromium_headless_shell-1217\chrome-headless-shell-win64\chrome-headless-shell.exe`;
const BASE = process.env.BENCH_BASE ?? 'http://localhost:9000';
const PAGE = `${BASE}/web/jxl-single-progressive.html?borders=0`;
const USE_CHROME = process.env.BENCH_CHROME === '1';
const BENCH_MODES = (process.env.BENCH_MODES ?? 'lastPasses,passes').split(',').map((s) => s.trim()).filter(Boolean);

async function launchBrowser() {
  if (USE_CHROME) {
    console.log(`Launching Chrome channel (headless=${process.env.BENCH_HEADFUL !== '1'})`);
    return chromium.launch({
      channel: 'chrome',
      headless: process.env.BENCH_HEADFUL !== '1',
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
  }
  return chromium.launch({
    executablePath: BROWSER_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
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

async function waitForRunComplete(page, timeoutMs = 600_000) {
  await page.waitForFunction(
    () => {
      const s = document.getElementById('single-status')?.textContent ?? '';
      return s.includes('Done.') || s.startsWith('Run failed:') || s.startsWith('Stopped early');
    },
    null,
    { timeout: timeoutMs },
  );
}

async function runOnce(page, { progressiveDetail, useWorker = true }) {
  await page.selectOption('#size-preset', 'original');
  await page.selectOption('#throttle-rate', '0');
  await page.selectOption('#progressive-detail', progressiveDetail);
  await page.locator('#decode-in-worker').setChecked(useWorker);
  await page.locator('#charts-enabled').setChecked(false);

  const retrieve = page.locator('#retrieve-run');
  await retrieve.waitFor({ state: 'visible', timeout: 60_000 });
  await page.waitForFunction(
    () => !document.getElementById('retrieve-run')?.disabled,
    null,
    { timeout: 120_000 },
  );

  const t0 = Date.now();
  await retrieve.click();
  await waitForRunComplete(page);
  const wallMs = Date.now() - t0;
  const metrics = await readMetrics(page);
  return { ...metrics, wallMs, progressiveDetail };
}

async function main() {
  const browser = await launchBrowser();

  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(0);
    page.on('console', (msg) => {
      if (msg.type() === 'error' || msg.text().includes('WASM baseline') || msg.text().includes('run failed')) {
        console.log(`[browser:${msg.type()}] ${msg.text()}`);
      }
    });
    page.on('pageerror', (err) => console.error(`[pageerror] ${err.message}`));

    console.log(`Navigating ${PAGE}`);
    await page.goto(PAGE, { waitUntil: 'networkidle', timeout: 120_000 });
    await page.waitForFunction(
      () => document.getElementById('retrieve-run') && !document.getElementById('retrieve-run').disabled,
      null,
      { timeout: 180_000 },
    );

    const wasmBaseline = await page.evaluate(async () => {
      const { getCapabilities } = await import('@casabio/jxl-capabilities');
      const caps = await getCapabilities();
      return {
        crossOriginIsolated: caps.crossOriginIsolated,
        sharedArrayBuffer: caps.sharedArrayBuffer,
        wasmThreads: caps.wasmThreads,
        wasmSimd: caps.wasmSimd,
        wasmRelaxedSimd: caps.wasmRelaxedSimd,
        selectedWasmBuild: caps.selectedWasmBuild,
      };
    });
    console.log('WASM baseline:', wasmBaseline);

    const modeDefs = {
      lastPasses: { progressiveDetail: 'lastPasses', useWorker: true, label: 'lastPasses/worker' },
      passes: { progressiveDetail: 'passes', useWorker: true, label: 'passes/worker (diagnostic)' },
    };
    const modes = BENCH_MODES.map((key) => modeDefs[key]).filter(Boolean);
    if (!modes.length) throw new Error(`No valid BENCH_MODES: ${BENCH_MODES.join(',')}`);
    const results = [];
    for (const mode of modes) {
      console.log(`\n=== Running ${mode.label} ===`);
      const row = await runOnce(page, { progressiveDetail: mode.progressiveDetail, useWorker: mode.useWorker });
      row.label = mode.label;
      results.push(row);
      console.log(JSON.stringify(row, null, 2));
      if (row.status.startsWith('Run failed')) {
        throw new Error(row.status);
      }
    }

    console.log('\n=== Summary (Original, throttle 0, worker decode) ===');
    console.log('Baseline (2026-06-07 findings): 12 passes, final ~6882 ms, one-shot ~723 ms, 9.52×');
    console.log('Target after F1+F2+F3: ~2–3 passes, final ≤ ~1500 ms, ratio ≤ ~2×\n');

    for (const r of results) {
      const passCount = Number.parseInt(r.passes, 10);
      const finalNum = Number.parseFloat(r.finalMs);
      const oneShotNum = Number.parseFloat(r.oneShotMs);
      const ratio = Number.isFinite(finalNum) && Number.isFinite(oneShotNum) && oneShotNum > 0
        ? (finalNum / oneShotNum).toFixed(2)
        : r.speedup;
      console.log(`${r.label ?? r.progressiveDetail}:`);
      console.log(`  passes: ${r.passes}`);
      console.log(`  first: ${r.firstMs}  final: ${r.finalMs}  one-shot: ${r.oneShotMs}  ratio: ${ratio}×`);
      console.log(`  encode: ${r.encodeMs}  dims: ${r.dims}  wall: ${r.wallMs} ms`);
      if (r.progressiveDetail === 'lastPasses') {
        const passOk = Number.isFinite(passCount) && passCount >= 2 && passCount <= 4;
        const finalOk = Number.isFinite(finalNum) && finalNum <= 2500;
        console.log(`  F1 pass-count check (2–4): ${passOk ? 'PASS' : 'FAIL'}`);
        console.log(`  F1 final_ms check (≤2500 ms): ${finalOk ? 'PASS' : 'FAIL'}`);
      }
      if (r.progressiveDetail === 'passes') {
        const passOk = Number.isFinite(passCount) && passCount >= 8;
        console.log(`  diagnostic pass-count check (≥8): ${passOk ? 'PASS' : 'FAIL'}`);
      }
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});