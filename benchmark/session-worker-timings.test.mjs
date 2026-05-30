import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

function readLocal(path) {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

test("session worker timing harness uses browser session path", () => {
  const page = readLocal("./session-worker-timings.html");
  const browser = readLocal("./session-worker-timings-browser.js");
  const runner = readLocal("./session-worker-timings.mjs");
  const worker = readLocal("./session-worker-forced-worker.js");

  assert.match(page, /@casabio\/jxl-session/);
  assert.match(browser, /import \{ createBrowserContext \} from ["']@casabio\/jxl-session["']/);
  assert.match(browser, /context\.encode\(makeEncoderOptions/);
  assert.match(browser, /context\.decode\(makeDecoderOptions/);
  assert.match(browser, /wasmUrl: new URL\("\.\/session-worker-forced-worker\.js"/);
  assert.doesNotMatch(browser, /createEncoder\(/);
  assert.doesNotMatch(browser, /createDecoder\(/);
  assert.match(worker, /setForcedTier\("simd"\)/);
  assert.match(runner, /chromium\.launch/);
  assert.match(runner, /runSessionWorkerTimings/);
});
