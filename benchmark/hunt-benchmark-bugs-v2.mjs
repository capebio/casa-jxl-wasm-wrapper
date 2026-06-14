// hunt-benchmark-bugs-v2.mjs
// Enhanced version of the dirty bug hunter.
// - Interacts with the on-page debug console we added.
// - Longer waits to allow our new timeout logic to fire.
// - Better scraping of status + debug panel content.
// - Targets the format race page aggressively (the worst "silent hang" case).

import { chromium } from "playwright";

const BROWSER_PATH = String.raw`C:\Users\User\AppData\Local\ms-playwright\chromium_headless_shell-1217\chrome-headless-shell-win64\chrome-headless-shell.exe`;

const t0 = Date.now();
const mark = (msg) => console.log(`[+${String(Date.now() - t0).padStart(6, " ")}ms] ${msg}`);

async function huntFormatRace() {
  mark("=== Enhanced Hunt: jxl-compare (format race) with debug console inspection ===");

  const browser = await chromium.launch({
    executablePath: BROWSER_PATH,
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  const allConsole = [];
  const pageErrors = [];
  const netFailures = [];

  page.on("console", (msg) => {
    const txt = `[${msg.type()}] ${msg.text()}`;
    allConsole.push(txt);
    if (msg.type() === "error" || /error|fail|hang|timeout|worker/i.test(msg.text())) {
      mark(`CONSOLE: ${txt}`);
    }
  });

  page.on("pageerror", (err) => {
    pageErrors.push(err.message);
    mark(`PAGEERROR: ${err.message}`);
  });

  page.on("requestfailed", (req) => {
    const f = `${req.url()} — ${req.failure()?.errorText}`;
    netFailures.push(f);
    mark(`NET FAIL: ${f}`);
  });

  try {
    await page.goto("http://localhost:9000/web/jxl-compare.html", { waitUntil: "networkidle", timeout: 30_000 });
    mark("Page loaded");

    await page.waitForTimeout(3000); // WASM + modules

    // Click the main Run button
    const runBtn = page.locator("#run-btn");
    if (await runBtn.isVisible() && await runBtn.isEnabled()) {
      mark("Clicking #run-btn (Load & run race)");
      await runBtn.click();
    } else {
      mark("Run button not ready");
    }

    // Wait long enough for our 18s timeout to potentially trigger
    mark("Waiting 25s for workflow + timeout path...");
    await page.waitForTimeout(25_000);

    // Now try to open the debug console we added
    const consoleBtn = page.locator("#dbg-console-btn");
    if (await consoleBtn.count() > 0) {
      mark("Clicking debug Console button...");
      await consoleBtn.click().catch(() => {});
      await page.waitForTimeout(1500);

      // Scrape the debug panel content
      const debugContent = await page.evaluate(() => {
        const panel = document.querySelector('.dbg-panel');
        if (!panel || panel.hidden) return "Debug panel not visible or hidden";
        const rows = Array.from(document.querySelectorAll('.dbg-row')).map(r => r.textContent.trim());
        return rows.slice(0, 20).join(" | ");
      });
      mark(`Debug panel content (first entries): ${debugContent}`);
    } else {
      mark("No #dbg-console-btn found on page");
    }

    // Final state snapshot
    const finalState = await page.evaluate(() => {
      return {
        status: (document.querySelector("#compare-status")?.textContent || "").trim(),
        results: (document.querySelector(".compare-empty")?.textContent || "").trim(),
        bodySnippet: document.body.innerText.slice(0, 600)
      };
    });
    mark("Final UI state: " + JSON.stringify(finalState, null, 2));

  } catch (err) {
    mark(`Hunt error: ${err.message}`);
  } finally {
    await browser.close();
  }

  mark("Captured page errors: " + (pageErrors.length ? pageErrors.join(" ; ") : "none"));
  mark("Captured network failures: " + (netFailures.length ? netFailures.slice(0,5).join(" ; ") : "none"));
  mark("Total console lines: " + allConsole.length);
}

async function main() {
  await huntFormatRace();
  mark("Enhanced v2 hunt complete.");
}

main().catch(console.error);