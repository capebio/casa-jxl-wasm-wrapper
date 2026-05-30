import { createServer } from "node:http";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, extname, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const TEST_ROOT = String.raw`C:\Foo\raw-converter\tests`;
const GOB_ROOT = String.raw`C:\995\2026-02-20 Gobabeb To Windhoek`;

function readNumberEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function readBoolEnv(name) {
  return /^(1|true|yes|on)$/i.test(process.env[name] ?? "");
}

const TEST_RUNS = readNumberEnv("TEST_RUNS", 1);
const TEST_SCAN_LIMIT = readNumberEnv("TEST_SCAN_LIMIT", Infinity);
const GOB_SCAN_LIMIT = readNumberEnv("GOB_SCAN_LIMIT", 0);
const GOB_OFFENDER_COUNT = readNumberEnv("GOB_OFFENDER_COUNT", 0);
const GOB_OFFENDER_RUNS = readNumberEnv("GOB_OFFENDER_RUNS", 0);
const TRACE_PROGRESS = readBoolEnv("TRACE_PROGRESS");
const TRACE_STAGES = readBoolEnv("TRACE_STAGES");
const SESSION_STAGE_TIMEOUT_MS = readNumberEnv("SESSION_STAGE_TIMEOUT_MS", 30000);
const SESSION_COMPLETION_TIMEOUT_MS = readNumberEnv("SESSION_COMPLETION_TIMEOUT_MS", 120000);
const SESSION_MAX_EDGE = readNumberEnv("SESSION_MAX_EDGE", Infinity);

const MIME = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".wasm", "application/wasm"],
]);

function fmtMs(value) {
  return `${value.toFixed(1)} ms`;
}

function fmtMb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function fmtDims(width, height) {
  return `${width}x${height}`;
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function fileTypeFromPath(path) {
  const lower = extname(path).toLowerCase();
  if (lower === ".orf" || lower === ".raw") return "orf";
  if (lower === ".dng") return "dng";
  if (lower === ".cr2") return "cr2";
  throw new Error(`Unsupported file type: ${path}`);
}

function loadFiles(root, predicate, limit, prefix) {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && predicate(entry.name))
    .map((entry) => join(root, entry.name))
    .sort((a, b) => a.localeCompare(b))
    .slice(0, limit)
    .map((path, index) => ({
      id: `${prefix}-${index}`,
      file: basename(path),
      path,
      type: fileTypeFromPath(path),
      sizeBytes: statSync(path).size,
    }));
}

function createRawMap(entries) {
  return new Map(entries.map((entry) => [entry.id, entry.path]));
}

function sendHeaders(res, status, type) {
  res.writeHead(status, {
    "Content-Type": type,
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Cross-Origin-Resource-Policy": "same-origin",
  });
}

function serveStatic(reqUrl, res) {
  const pathname = reqUrl.pathname === "/" ? "/benchmark/session-worker-timings.html" : reqUrl.pathname;
  const decoded = decodeURIComponent(pathname).replace(/^\/+/, "");
  const fullPath = normalize(join(REPO_ROOT, decoded));
  const rel = relative(REPO_ROOT, fullPath);
  if (rel.startsWith("..") || rel === "" || rel.split(sep).includes("..")) {
    sendHeaders(res, 403, "text/plain; charset=utf-8");
    res.end("Forbidden");
    return;
  }
  try {
    const data = readFileSync(fullPath);
    sendHeaders(res, 200, MIME.get(extname(fullPath).toLowerCase()) ?? "application/octet-stream");
    res.end(data);
  } catch (error) {
    sendHeaders(res, 404, "text/plain; charset=utf-8");
    res.end(`Not found: ${pathname}\n${error?.message ?? error}`);
  }
}

function startServer(rawMap) {
  const server = createServer((req, res) => {
    const reqUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    if (reqUrl.pathname === "/__raw-file") {
      const id = reqUrl.searchParams.get("id");
      const path = id ? rawMap.get(id) : null;
      if (!path) {
        sendHeaders(res, 404, "text/plain; charset=utf-8");
        res.end("Unknown raw file id");
        return;
      }
      const data = readFileSync(path);
      sendHeaders(res, 200, "application/octet-stream");
      res.end(data);
      return;
    }
    serveStatic(reqUrl, res);
  });

  return new Promise((resolveListen) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolveListen({ server, port: address.port });
    });
  });
}

function withUrls(entries, port) {
  return entries.map((entry) => ({
    ...entry,
    url: `http://127.0.0.1:${port}/__raw-file?id=${encodeURIComponent(entry.id)}`,
  }));
}

function derived(row) {
  const totalMs = row.rawWallMs + row.rgbaPrepMs + row.encodeMs + row.decodeMs;
  return { totalMs };
}

function printTable(title, rows, limit = rows.length) {
  console.log(`\n=== ${title} ===`);
  for (const row of rows.slice(0, limit)) {
    const extra = derived(row);
    console.log(
      [
        row.file,
        `${row.type.toUpperCase()} ${fmtDims(row.width, row.height)} work ${fmtDims(row.workWidth ?? row.width, row.workHeight ?? row.height)}`,
        fmtMb(row.sizeBytes),
        `rawWall ${fmtMs(row.rawWallMs)}`,
        `prep ${fmtMs(row.rgbaPrepMs)}`,
        `enc ${fmtMs(row.encodeMs)}`,
        `first ${fmtMs(row.firstChunkMs)}`,
        `dec ${fmtMs(row.decodeMs)}`,
        `jxl ${fmtMb(row.jxlBytes)}`,
        `total ${fmtMs(extra.totalMs)}`,
      ].join(" | "),
    );
  }
}

function printAggregate(title, rows) {
  const raw = rows.map((row) => row.rawWallMs);
  const enc = rows.map((row) => row.encodeMs);
  const dec = rows.map((row) => row.decodeMs);
  const total = rows.map((row) => derived(row).totalMs);
  console.log(
    [
      `${title}:`,
      `count=${rows.length}`,
      `rawWall avg ${fmtMs(mean(raw))}`,
      `enc avg ${fmtMs(mean(enc))}`,
      `dec avg ${fmtMs(mean(dec))}`,
      `total avg ${fmtMs(mean(total))}`,
    ].join(" "),
  );
}

async function main() {
  const testEntries = loadFiles(
    TEST_ROOT,
    (name) => [".orf", ".raw", ".dng", ".cr2"].includes(extname(name).toLowerCase()),
    TEST_SCAN_LIMIT,
    "test",
  );
  const gobEntries = loadFiles(
    GOB_ROOT,
    (name) => extname(name).toLowerCase() === ".orf",
    GOB_SCAN_LIMIT,
    "gob",
  );
  const rawMap = createRawMap([...testEntries, ...gobEntries]);
  const { server, port } = await startServer(rawMap);
  let browser = null;

  console.log("session-worker-timings");
  console.log(
      `config testRuns=${TEST_RUNS} testScanLimit=${TEST_SCAN_LIMIT} gobScanLimit=${GOB_SCAN_LIMIT} gobOffenderCount=${GOB_OFFENDER_COUNT} gobOffenderRuns=${GOB_OFFENDER_RUNS} sessionMaxEdge=${SESSION_MAX_EDGE} traceProgress=${TRACE_PROGRESS} traceStages=${TRACE_STAGES}`,
  );

  try {
    browser = await chromium.launch({ headless: process.env.SESSION_HEADLESS !== "0" });
    const page = await browser.newPage();
    page.setDefaultTimeout(0);
    page.on("console", (msg) => {
      if (TRACE_PROGRESS || TRACE_STAGES || msg.type() === "error") {
        console.log(`[browser:${msg.type()}] ${msg.text()}`);
      }
    });
    page.on("pageerror", (error) => {
      console.error(`[browser:pageerror] ${error.stack ?? error.message}`);
    });
    await page.goto(`http://127.0.0.1:${port}/benchmark/session-worker-timings.html`, {
      waitUntil: "load",
      timeout: 60000,
    });
    await page.waitForFunction(() => typeof window.runSessionWorkerTimings === "function", null, {
      timeout: 60000,
    });

    const result = await page.evaluate(
      (config) => window.runSessionWorkerTimings(config),
      {
        testEntries: withUrls(testEntries, port),
        gobEntries: withUrls(gobEntries, port),
        testRuns: TEST_RUNS,
        gobOffenderCount: GOB_OFFENDER_COUNT,
        gobOffenderRuns: GOB_OFFENDER_RUNS,
        traceProgress: TRACE_PROGRESS,
        traceStages: TRACE_STAGES,
        maxEdge: SESSION_MAX_EDGE,
        timeouts: {
          stageMs: SESSION_STAGE_TIMEOUT_MS,
          completionMs: SESSION_COMPLETION_TIMEOUT_MS,
        },
      },
    );

    printTable("Session Worker Tests Ranked By Total", result.testRows);
    printAggregate("Session worker tests aggregate", result.testRows);
    printTable("Session Worker Gobabeb Scan Top 12", result.gobScanRows, 12);
    printAggregate("Session worker Gobabeb scan aggregate", result.gobScanRows);
    printTable("Session Worker Gobabeb Offenders Re-measured", result.gobOffenders);
    printAggregate("Session worker Gobabeb offenders aggregate", result.gobOffenders);
  } finally {
    await browser?.close().catch(() => {});
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
