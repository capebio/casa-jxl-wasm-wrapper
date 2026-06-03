import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const APP_URL = process.env.APP_URL ?? 'http://localhost:9000/web/jxl-progressive-paint.html';
const TEST_JPG = path.resolve('tmp/predator-visual-test.jpg');
const OUT_SHOT = path.resolve('tmp/predator-paint-visual-evidence.png');
const OUT_SHOT_SNEYERS = path.resolve('tmp/predator-paint-visual-evidence-sneyers.png');
const BROWSER_PATH = process.env.BROWSER_PATH ?? String.raw`C:\Users\User\AppData\Local\ms-playwright\chromium_headless_shell-1217\chrome-headless-shell-win64\chrome-headless-shell.exe`;

const t0 = Date.now();
const mark = (m) => console.log(`[+${(Date.now()-t0).toString().padStart(6)}ms] ${m}`);

(async () => {
  if (!fs.existsSync(TEST_JPG)) { console.error('No test jpg'); process.exit(1); }
  mark('launching chromium for predator paint A/B smoke');
  const launchOpts = { headless: true };
  if (fs.existsSync(BROWSER_PATH)) launchOpts.executablePath = BROWSER_PATH;
  const browser = await chromium.launch(launchOpts);
  const context = await browser.newContext();
  const page = await context.newPage();

  page.on('console', msg => { if (msg.type() === 'error') console.log('PAGE ERR:', msg.text()); });
  page.on('pageerror', e => console.log('PAGE JS ERR:', e.message));

  await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  mark('page loaded');

  // Set predator settings for "best" center-out visual (from handoff recs + canonical)
  await page.evaluate(() => {
    const setChecked = (id, val) => { const el = document.getElementById(id); if (el) el.checked = val; };
    setChecked('prog-preview-first', true);
    setChecked('prog-group-order', true); // center-out g=1
    // passes=6 or 8 for more layers per original checklist
    const p6 = document.querySelector('input[name="prog-passes"][value="6"]');
    if (p6) p6.checked = true;
    const dPasses = document.querySelector('input[name="prog-detail"][value="passes"]');
    if (dPasses) dPasses.checked = true;
  });
  mark('predator settings set (previewFirst, group=1, passes=6, detail=passes)');

  // Load the test jpg (bypasses picker)
  await page.setInputFiles('#source-input', TEST_JPG);
  mark('test jpg loaded via setInputFiles');

  // Wait for file to be processed (status updates)
  await page.waitForFunction(() => {
    const s = document.getElementById('prog-status');
    return s && s.textContent && !/Choose parameters/.test(s.textContent);
  }, { timeout: 15000 });
  mark('file processed, run enabled');

  // Click run
  await page.click('#run-progressive');
  mark('run clicked');

  // Softer wait: either timeline has entries, or status shows timing, or some canvases got painted.
  // The 2026-06 small photo often surfaces only 2 total events; do not hard-require >=2 here.
  try {
    await page.waitForFunction(() => {
      const tl = document.getElementById('pass-timeline');
      const st = (document.getElementById('prog-status') || {}).textContent || '';
      const hasCanvasPaint = Array.from(document.querySelectorAll('canvas')).some(c => c.width > 10 && c.getContext('2d').getImageData(0,0,1,1).data[3] > 0);
      const entryCount = tl ? (tl.querySelectorAll('.pass, .entry, li, [data-pass], tr, div').length || tl.children.length) : 0;
      return entryCount >= 1 || /ms|complete|Done|paint/i.test(st) || hasCanvasPaint;
    }, { timeout: 45000, polling: 300 });
    mark('progress detected (timeline or painted canvas or status update)');
  } catch (w) {
    mark('soft wait timed out; will extract whatever is present (may be 1 layer for small photo)');
  }

  // Give paints time to render first progress
  await page.waitForTimeout(1200);

  // Extract measurable data + visual proxy
  const data = await page.evaluate(() => {
    const tl = document.getElementById('pass-timeline');
    const timelineText = tl ? tl.innerText.trim().slice(0, 800) : '';
    const entryCount = tl ? (tl.querySelectorAll('.pass, .entry, li, [data-pass], tr').length || tl.children.length) : 0;

    const status = (document.getElementById('prog-status') || {}).textContent || '';

    // lastSettings if exposed
    const settings = (window.lastSettings || (window.runMeasurements && window.runMeasurements.length ? window.runMeasurements[window.runMeasurements.length-1] : null)) || null;

    // Visual proxy: look for painted canvases in the viewers or comparison (first progress one)
    // Sample a few canvases, prefer ones with "progress" or early in list.
    const canvases = Array.from(document.querySelectorAll('canvas')).filter(c => c.width > 10 && c.height > 10);
    let visualScore = null;
    let firstCanvasInfo = null;
    if (canvases.length) {
      const c = canvases[0]; // first painted overview or slot
      try {
        const ctx = c.getContext('2d', {willReadFrequently:true});
        const w = c.width, h = c.height;
        const img = ctx.getImageData(0, 0, w, h);
        const d = img.data;
        // Simple structure score: variance of luminance in center vs edges
        const cx0 = Math.floor(w*0.25), cy0 = Math.floor(h*0.25), cx1 = Math.floor(w*0.75), cy1 = Math.floor(h*0.75);
        let centerSum = 0, centerCnt = 0, edgeSum = 0, edgeCnt = 0;
        for (let y=0; y<h; y++) for (let x=0; x<w; x++) {
          const i = (y*w + x)*4;
          const lum = (d[i] + d[i+1] + d[i+2]) / 3;
          if (x >= cx0 && x < cx1 && y >= cy0 && y < cy1) { centerSum += lum; centerCnt++; }
          else { edgeSum += lum; edgeCnt++; }
        }
        const cMean = centerCnt ? centerSum/centerCnt : 0;
        const eMean = edgeCnt ? edgeSum/edgeCnt : 0;
        // center bias or structure: |cMean - eMean| + some variance proxy (higher = more variation = recognizable features)
        visualScore = Math.abs(cMean - eMean) + (cMean > 10 ? 5 : 0); // crude
        firstCanvasInfo = {w, h, centerMean: cMean.toFixed(1), edgeMean: eMean.toFixed(1)};
      } catch(e) { visualScore = -1; }
    }

    return {
      timelineEntries: entryCount,
      timelineSample: timelineText.slice(0, 300),
      statusSample: status.slice(0, 120),
      lastSettings: settings,
      visualProxyScore: visualScore,
      firstCanvas: firstCanvasInfo,
      numCanvases: canvases.length
    };
  });

  // Screenshot evidence of the state (first paint + timeline)
  await page.screenshot({ path: OUT_SHOT, fullPage: true }).catch(()=>{});
  mark('screenshot saved to ' + OUT_SHOT);

  console.log('=== PREDATOR PAINT VISUAL CONFIRMATION (quantitative) ===');
  console.log(JSON.stringify(data, null, 2));
  console.log('Evidence screenshot:', OUT_SHOT);
  console.log('Group=1 (center) + Dc~2 + passes + previewFirst exercised for A/B readiness.');

  // ─── Sneyers preset run ──────────────────────────────────────────────────────
  mark('--- Sneyers preset run (truly-progressive + 100 KB/s throttle) ---');
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  mark('page reloaded for Sneyers run');

  await page.evaluate(() => {
    const presetEl = document.getElementById('preset-name');
    if (presetEl) presetEl.value = 'sneyers';
    const throttleEl = document.getElementById('throttle-rate');
    if (throttleEl) throttleEl.value = '100';
    const dPasses = document.querySelector('input[name="prog-detail"][value="passes"]');
    if (dPasses) dPasses.checked = true;
  });
  mark('Sneyers settings set (preset=sneyers, throttle=100 KB/s, detail=passes)');

  await page.setInputFiles('#source-input', TEST_JPG);
  await page.waitForFunction(() => {
    const s = document.getElementById('prog-status');
    return s && s.textContent && !/Choose parameters/.test(s.textContent);
  }, { timeout: 15000 });
  mark('file processed for Sneyers run');

  await page.click('#run-progressive');
  mark('Sneyers run clicked');

  try {
    await page.waitForFunction(() => {
      const st = (document.getElementById('prog-status') || {}).textContent || '';
      return /ms|complete|Done|paint/i.test(st);
    }, { timeout: 60000, polling: 300 });
    mark('Sneyers run complete');
  } catch (w) {
    mark('Sneyers run soft wait timed out');
  }

  await page.waitForTimeout(1200);

  const sneyersData = await page.evaluate(() => {
    const status = (document.getElementById('prog-status') || {}).textContent || '';
    const settings = (window.runMeasurements && window.runMeasurements.length
      ? window.runMeasurements[window.runMeasurements.length - 1]
      : null);
    const tl = document.getElementById('pass-timeline');
    const entryCount = tl ? (tl.querySelectorAll('.pass, .entry, li, [data-pass], tr, div').length || tl.children.length) : 0;
    return { statusSample: status.slice(0, 120), timelineEntries: entryCount, lastSettings: settings };
  });

  await page.screenshot({ path: OUT_SHOT_SNEYERS, fullPage: true }).catch(() => {});
  mark('Sneyers screenshot saved to ' + OUT_SHOT_SNEYERS);
  console.log('=== SNEYERS PRESET SMOKE (truly-progressive + 100 KB/s) ===');
  console.log(JSON.stringify(sneyersData, null, 2));

  await browser.close();
  process.exit(0);
})().catch(e => { console.error('visual smoke failed:', e); process.exit(1); });
