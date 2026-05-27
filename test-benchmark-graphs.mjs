import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const BROWSER_PATH = String.raw`C:\Users\User\AppData\Local\ms-playwright\chromium_headless_shell-1217\chrome-headless-shell-win64\chrome-headless-shell.exe`;
const URL = "http://localhost:9000/web/jxl-benchmark.html";

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

async function configureMinimalRun(page) {
    await page.locator("#max-files").fill("1");
    await page.locator("#iterations").fill("1");

    const sizeChecks = page.locator('input[name="benchmark-size"]');
    const sizeCount = await sizeChecks.count();
    for (let i = 0; i < sizeCount; i++) {
        const cb = sizeChecks.nth(i);
        const value = await cb.getAttribute("value");
        const checked = await cb.isChecked();
        if (checked && value !== "128") await cb.uncheck();
        if (!checked && value === "128") await cb.check();
    }
}

async function runBenchmark(page) {
    await page.locator("#load-random").click();
    await page.waitForFunction(
        () => document.getElementById("selection-status")?.textContent?.includes("file"),
        { timeout: 120_000 }
    );
    await page.locator("#start-benchmark").click();
    await page.waitForFunction(
        () => document.getElementById("progress-status")?.textContent?.includes("Benchmark complete"),
        { timeout: 120_000 }
    );
}

async function exportDecodeLatencyCsv(page) {
    await page.locator("#decode-latency-container").hover();
    const downloadPromise = page.waitForEvent("download", { timeout: 10_000 });
    await page.locator("#decode-latency-container .export-csv").click();
    const download = await downloadPromise;
    const path = await download.path();
    assert(path, "expected CSV download path");
    return readFileSync(path, "utf8");
}

const browser = await chromium.launch({
    executablePath: BROWSER_PATH,
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
});

try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1200 } });
    await page.goto(URL, { waitUntil: "load", timeout: 30_000 });

    await configureMinimalRun(page);
    await runBenchmark(page);

    const beforeClear = await exportDecodeLatencyCsv(page);
    assert(beforeClear.includes("128px,"), "expected benchmark CSV before clear");

    await page.locator("#clear-results").click();
    await page.waitForTimeout(300);

    assert(await page.locator("#decode-latency-container .export-csv").isDisabled(), "graph export should be disabled after clear");

    console.log("benchmark graph clear-state regression test passed");
} finally {
    await browser.close();
}
