// Headless-browser probe: open the demo, click the picker, attach an ORF
// programmatically, log every console message, every uncaught error, every
// network failure, until processing completes or 60 s elapse.

import { chromium } from "playwright";

const ORF = process.env.TEST_ORF ?? String.raw`c:\995\2026-01-09 Birthday at Cederberg\P1100085.ORF`;
const URL = "http://localhost:8090/";

const browser = await chromium.launch({
    headless: true,
    executablePath: String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`,
});
try {
    const context = await browser.newContext();
    const page = await context.newPage();

    page.on("console", (m) => console.log(`[${m.type()}]`, m.text()));
    page.on("pageerror", (e) => console.log("[pageerror]", e.message));
    page.on("requestfailed", (r) =>
        console.log("[netfail]", r.url(), r.failure()?.errorText),
    );
    page.on("response", (r) => {
        if (r.status() >= 400) console.log("[http]", r.status(), r.url());
    });

    console.log("--- navigating");
    await page.goto(URL, { waitUntil: "networkidle" });

    console.log("--- screenshot before interaction");
    await page.screenshot({ path: "C:\\foo\\raw-converter-wasm\\page-initial.png", fullPage: true });
    const html = await page.content();
    console.log("html length:", html.length);
    console.log("html head:", html.slice(0, 300));

    console.log("--- inspecting DOM");
    const buttonText = await page.locator("#pick").textContent();
    console.log("pick button text:", buttonText);

    console.log("--- setting file via input.files");
    await page.locator("#file-input").setInputFiles(ORF);

    console.log("--- waiting for thumb (pipeline only)");
    const start = Date.now();
    try {
        await page.waitForSelector(".thumb:not(.busy)", { timeout: 60000 });
        console.log(`thumb visible at ${Date.now() - start} ms`);

        console.log("--- waiting for JXL encode complete");
        await page.waitForSelector(".thumb:not(.busy):not(.encoding)", { timeout: 60000 });
        console.log(`JXL done at ${Date.now() - start} ms`);

        const meta = await page.evaluate(() => {
            const c = document.querySelector(".thumb");
            return (c && '_meta' in c) ? (c as any)._meta : null;
        });
        console.log("meta:", meta);

        await page.screenshot({ path: "C:\\foo\\raw-converter-wasm\\page-after.png", fullPage: true });
        console.log("--- screenshot after");
    } catch (err) {
        console.log("--- TIMEOUT before any thumb completed");
        const thumbCount = await page.locator(".thumb").count();
        console.log("thumbs in DOM:", thumbCount);
        if (thumbCount > 0) {
            const cls = await page.locator(".thumb").first().getAttribute("class");
            const innerErr = await page.locator(".thumb").first().getAttribute("data-error");
            console.log("first thumb class:", cls, "error:", innerErr);
        }
    }
} finally {
    await browser.close();
}
