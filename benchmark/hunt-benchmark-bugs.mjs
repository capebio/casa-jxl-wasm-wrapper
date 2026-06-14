// hunt-benchmark-bugs.mjs
// Different, runtime browser-driven error hunter for the benchmark pages.
// Uses the project's existing Playwright + chromium path pattern.
// Exercises the main "nothing happens / stuck running" workflows and captures
// console, page errors, network failures, and DOM state.

import { chromium } from "playwright";

const BROWSER_PATH = String.raw`C:\Users\User\AppData\Local\ms-playwright\chromium_headless_shell-1217\chrome-headless-shell-win64\chrome-headless-shell.exe`;

const PAGES_TO_TEST = [
  { name: "jxl-benchmark", url: "http://localhost:9000/web/jxl-benchmark.html" },
  { name: "jxl-compare (format race)", url: "http://localhost:9000/web/jxl-compare.html" },
];

const t0 = Date.now();
const mark = (msg) => console.log(`[+${String(Date.now() - t0).padStart(6, " ")}ms] ${msg}`);

async function testPage({ name, url }) {
  mark(`=== Starting test for ${name} ===`);
  mark(`Navigating to ${url}`);

  const browser = await chromium.launch({
    executablePath: BROWSER_PATH,
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  const consoleLogs = [];
  const pageErrors = [];
  const requestFailures = [];

  page.on("console", (msg) => {
    const entry = `[${msg.type()}] ${msg.text()}`;
    consoleLogs.push(entry);
    if (msg.type() === "error" || msg.text().toLowerCase().includes("error")) {
      mark(`CONSOLE ERROR: ${entry}`);
    }
  });

  page.on("pageerror", (err) => {
    pageErrors.push(err.message);
    mark(`PAGE ERROR: ${err.message}`);
  });

  page.on("requestfailed", (req) => {
    const failure = `${req.url()} — ${req.failure()?.errorText || "unknown"}`;
    requestFailures.push(failure);
    mark(`REQUEST FAILED: ${failure}`);
  });

  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: 25_000 });
    mark("Page loaded (networkidle)");

    // Give WASM / module initialization time (common source of silent failure)
    await page.waitForTimeout(2500);

    // Try to find and click the primary "random" / load buttons that users complain about
    const randomSelectors = [
      "#load-random",
      "button:has-text('Random')",
      "button:has-text('Load 5 random')",
      "#run-btn",                    // format race
    ];

    let clickedSomething = false;

    for (const sel of randomSelectors) {
      const loc = page.locator(sel).first();
      if (await loc.count() > 0) {
        const isVisible = await loc.isVisible().catch(() => false);
        const isEnabled = await loc.isEnabled().catch(() => false);
        const txt = (await loc.textContent().catch(() => "")).trim();
        mark(`Found button ${sel} → visible=${isVisible} enabled=${isEnabled} text="${txt}"`);

        if (isVisible && isEnabled) {
          mark(`Clicking ${sel}...`);
          await loc.click({ timeout: 3000 }).catch(e => mark(`Click failed: ${e.message}`));
          clickedSomething = true;
          await page.waitForTimeout(4000); // let the async workflow run (this is where hangs usually appear)
          break;
        }
      }
    }

    if (!clickedSomething) {
      mark("No clickable primary action button found — page may be in a broken initial state");
    }

    // Capture current visible status / error areas
    const statusTexts = await page.evaluate(() => {
      const candidates = [
        "#compare-status", "#batch-status", "#progress-status",
        ".compare-empty", "#selection-status", "[id*='status']", ".error", "[class*='error']"
      ];
      const out = {};
      for (const sel of candidates) {
        const el = document.querySelector(sel);
        if (el) out[sel] = (el.textContent || "").trim().slice(0, 200);
      }
      return out;
    });

    mark("Post-click status snapshot: " + JSON.stringify(statusTexts, null, 2));

    // Look for obvious "stuck" or "running" text
    const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 800));
    if (bodyText.toLowerCase().includes("running") || bodyText.toLowerCase().includes("loading")) {
      mark("WARNING: Page still shows 'running' / 'loading' text after action");
    }

  } catch (err) {
    mark(`FATAL during page test: ${err.message}`);
    pageErrors.push(`FATAL: ${err.message}`);
  } finally {
    await browser.close();
  }

  return {
    name,
    consoleErrors: consoleLogs.filter(l => l.includes("error") || l.includes("Error") || l.includes("failed")),
    pageErrors,
    requestFailures: requestFailures.slice(0, 8),
  };
}

async function main() {
  mark("=== Dirty Bug Hunter — Browser-driven probe ===");

  const results = [];

  for (const pageDef of PAGES_TO_TEST) {
    try {
      const res = await testPage(pageDef);
      results.push(res);
    } catch (e) {
      mark(`Top-level failure testing ${pageDef.name}: ${e.message}`);
    }
  }

  mark("\n=== FINAL HUNT REPORT ===");
  for (const r of results) {
    console.log(`\n--- ${r.name} ---`);
    console.log("Console errors captured:", r.consoleErrors.length ? r.consoleErrors : "(none or non-error)");
    console.log("Page errors:", r.pageErrors.length ? r.pageErrors : "(none)");
    console.log("Network failures (first few):", r.requestFailures.length ? r.requestFailures : "(none)");
  }

  mark("\nHunt complete. Look for patterns above (especially request failures to /api/random and any 'worker' or 'session' errors).");
}

main().catch(e => {
  console.error("Probe script crashed:", e);
  process.exit(1);
});