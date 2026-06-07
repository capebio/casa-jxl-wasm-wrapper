import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { extname, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const JXL_PATH = process.env.PROBE_JXL ?? join(REPO_ROOT, "docs", "Benchmark results", "P2200619-prog-p6-q85.jxl");
const TIERS = (process.env.PROBE_TIERS ?? "simd,relaxed-simd-mt").split(",").map((s) => s.trim()).filter(Boolean);

const MIME = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".wasm", "application/wasm"],
  [".json", "application/json; charset=utf-8"],
  [".jxl", "application/octet-stream"],
]);

function sendHeaders(res, status, type) {
  res.writeHead(status, {
    "Content-Type": type,
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Cross-Origin-Resource-Policy": "same-origin",
  });
}

function startServer() {
  const server = createServer((req, res) => {
    const reqUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    if (reqUrl.pathname === "/__jxl") {
      const data = readFileSync(JXL_PATH);
      sendHeaders(res, 200, "application/octet-stream");
      res.end(data);
      return;
    }
    const pathname = reqUrl.pathname === "/" ? "/benchmark/progressive-worker-probe.html" : reqUrl.pathname;
    const decoded = decodeURIComponent(pathname).replace(/^\/+/, "");
    const fullPath = normalize(join(REPO_ROOT, decoded));
    const rel = relative(REPO_ROOT, fullPath);
    if (rel.startsWith("..") || rel.split(sep).includes("..")) {
      sendHeaders(res, 403, "text/plain");
      res.end("Forbidden");
      return;
    }
    try {
      const data = readFileSync(fullPath);
      sendHeaders(res, 200, MIME.get(extname(fullPath).toLowerCase()) ?? "application/octet-stream");
      res.end(data);
    } catch (err) {
      sendHeaders(res, 404, "text/plain");
      res.end(`Not found: ${pathname}\n${err?.message ?? err}`);
    }
  });
  return new Promise((res) => {
    server.listen(0, "127.0.0.1", () => res({ server, port: server.address().port }));
  });
}

async function main() {
  const { server, port } = await startServer();
  let browser = null;
  console.log(`progressive-worker-probe jxl=${JXL_PATH} tiers=${TIERS.join(",")}`);
  try {
    browser = await chromium.launch({ headless: process.env.PROBE_HEADLESS !== "0" });
    const page = await browser.newPage();
    page.setDefaultTimeout(0);
    page.on("console", (m) => {
      if (m.type() === "error") console.log(`[browser:error] ${m.text()}`);
    });
    page.on("pageerror", (e) => console.error(`[pageerror] ${e.stack ?? e.message}`));
    await page.goto(`http://127.0.0.1:${port}/benchmark/progressive-worker-probe.html`, { waitUntil: "load", timeout: 60000 });
    await page.waitForFunction(() => typeof window.runProbe === "function", null, { timeout: 60000 });

    for (const tier of TIERS) {
      const jxlUrl = `http://127.0.0.1:${port}/__jxl`;
      const r = await page.evaluate((args) => window.runProbe(args), { jxlUrl, tier });
      console.log(`\n=== tier=${r.tier} ===`);
      console.log(
        [
          `encoded ${(r.encodedBytes / 1024 / 1024).toFixed(2)} MB`,
          `oneShot ${r.oneShotMs} ms`,
          `passes ${r.passCount}`,
          `final ${r.finalMs} ms`,
          `total ${r.totalMs} ms`,
          `perPass mean ${r.perPassMeanMs} ms (min ${r.perPassMinMs} / max ${r.perPassMaxMs})`,
          `ratio final/oneShot ${(r.finalMs / r.oneShotMs).toFixed(1)}x`,
        ].join(" | "),
      );
    }
  } finally {
    await browser?.close().catch(() => {});
    await new Promise((res) => server.close(res));
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
