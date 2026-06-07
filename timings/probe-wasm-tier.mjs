#!/usr/bin/env node
import { chromium } from 'playwright';

const BASE = process.env.BENCH_BASE ?? 'http://localhost:9000';
const useChrome = process.env.BENCH_CHROME === '1';

const browser = await (useChrome
  ? chromium.launch({ channel: 'chrome', headless: true, args: ['--no-sandbox'] })
  : chromium.launch({ headless: true, args: ['--no-sandbox'] }));
const page = await browser.newPage();
await page.goto(`${BASE}/web/jxl-single-progressive.html?borders=0`, { waitUntil: 'domcontentloaded' });
const probes = await page.evaluate(async () => {
  const simdBytes = new Uint8Array([0,97,115,109,1,0,0,0,1,5,1,96,0,1,123,3,2,1,0,10,8,1,6,0,65,0,253,15,11]);
  const threadBytes = new Uint8Array([0,97,115,109,1,0,0,0,1,4,1,96,0,0,3,2,1,0,5,3,1,3,1,10,11,1,9,0,65,0,254,16,2,0,26,11]);
  const { getCapabilities } = await import('@casabio/jxl-capabilities');
  const caps = await getCapabilities();
  return {
    validateSimd: WebAssembly.validate(simdBytes),
    validateThreads: WebAssembly.validate(threadBytes),
    caps,
    ua: navigator.userAgent,
  };
});
console.log(JSON.stringify(probes, null, 2));
await browser.close();