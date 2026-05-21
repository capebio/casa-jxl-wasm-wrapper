// Browser sweep for file open/display paths.
// Logs launcher, navigation, console, page errors, card states, timings, and
// lightbox/view-switch permutations.

import { chromium } from "playwright";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";

const APP_URL = process.env.APP_URL ?? process.env.URL ?? "http://localhost:9000/web/index.html";
const BROWSER_PATH = process.env.BROWSER_PATH ?? String.raw`C:\Users\User\AppData\Local\ms-playwright\chromium_headless_shell-1217\chrome-headless-shell-win64\chrome-headless-shell.exe`;
const DEFAULT_FILES = [
    String.raw`C:\995\2026-02-17 Dave at Kyffhauser\P2140298 Aloidendron dichotomum.ORF`,
    String.raw`C:\995\2026-02-17 Dave at Kyffhauser\P2140301.ORF`,
    String.raw`C:\995\2026-02-17 Dave at Kyffhauser\P2140307 Hermannia eenioides.ORF`,
];

const inputFiles = process.argv.slice(2);
const files = inputFiles.length > 0 ? inputFiles : DEFAULT_FILES;

const t0 = Date.now();
const mark = (msg: string) => console.log(`[+${String(Date.now() - t0).padStart(6, " ")}ms] ${msg}`);

function formatFiles(list: string[]) {
    return list.map((f, i) => `${i + 1}:${f}`).join(" | ");
}

async function dumpStats(page: any, label: string) {
    const text = await page.locator("#stats-log").textContent().catch(() => null);
    if (text && text.trim()) {
        mark(`${label} stats:\n${text.trim()}`);
    }
}

async function dumpThumbs(page: any, label: string) {
    const thumbs = await page.locator(".thumb").count();
    const summary = await page.evaluate(() => {
        return Array.from(document.querySelectorAll(".thumb")).map((el, idx) => {
            const card = el as HTMLElement;
            const title = card.querySelector(".name")?.textContent?.trim() ?? "";
            const classes = card.className;
            const err = card.getAttribute("data-error") ?? "";
            const src = card.getAttribute("data-thumb-src") ?? "";
            return `${idx + 1}:{title="${title}", src="${src}", busy=${classes.includes("busy")}, encoding=${classes.includes("encoding")}, error=${classes.includes("error")}, data-error="${err}"}`;
        }).join(" | ");
    });
    mark(`${label} thumbs=${thumbs}${summary ? `\n${summary}` : ""}`);
}

async function waitForThumbs(page: any, expected: number, timeoutMs: number) {
    await page.waitForFunction(
        (n: number) => {
            const thumbs = Array.from(document.querySelectorAll(".thumb"));
            return thumbs.length >= n && thumbs.every((el) => {
                const card = el as HTMLElement;
                return !card.classList.contains("error") && !card.classList.contains("busy") && !card.classList.contains("encoding");
            });
        },
        expected,
        { timeout: timeoutMs },
    );
}

async function waitForAnyThumbCanvas(page: any, expected: number, timeoutMs: number) {
    await page.waitForFunction(
        (n: number) => document.querySelectorAll(".thumb canvas").length >= n,
        expected,
        { timeout: timeoutMs },
    );
}

async function selectView(page: any, view: "rect" | "square" | "natural") {
    const btn = page.locator(`button.view-btn[data-view="${view}"]`);
    await btn.click({ timeout: 10000 });
    await page.waitForFunction(
        (v: string) => document.querySelector(`button.view-btn[data-view="${v}"]`)?.classList.contains("active") === true,
        view,
        { timeout: 10000 },
    );
    const gridClass = await page.locator("#grid").getAttribute("class");
    mark(`view=${view} grid.class="${gridClass ?? ""}"`);
}

async function openLightboxAndReport(page: any, cardIndex: number) {
    const thumbs = page.locator(".thumb");
    await thumbs.nth(cardIndex).click({ timeout: 10000 });
    await page.locator("#lightbox").waitFor({ state: "visible", timeout: 10000 });

    const state = await page.evaluate(() => {
        const canvas = document.getElementById("lightbox-canvas") as HTMLCanvasElement | null;
        const sourceLabel = document.getElementById("lb-source-label")?.textContent?.trim() ?? "";
        const banner = document.getElementById("lb-source-banner")?.textContent?.trim() ?? "";
        const toggle = document.querySelector(".lb-toggle-jpeg")?.textContent?.trim() ?? "";
        return {
            width: canvas?.width ?? 0,
            height: canvas?.height ?? 0,
            sourceLabel,
            banner,
            toggle,
        };
    });
    mark(`lightbox card=${cardIndex + 1} canvas=${state.width}x${state.height} banner="${state.banner}" toggle="${state.toggle}" label="${state.sourceLabel}"`);
    return state;
}

async function cycleLightboxSource(page: any, steps: number) {
    const button = page.locator(".lb-toggle-jpeg");
    for (let i = 0; i < steps; i++) {
        await button.click({ timeout: 10000 });
        const state = await page.evaluate(() => {
            const canvas = document.getElementById("lightbox-canvas") as HTMLCanvasElement | null;
            const sourceLabel = document.getElementById("lb-source-label")?.textContent?.trim() ?? "";
            const banner = document.getElementById("lb-source-banner")?.textContent?.trim() ?? "";
            const toggle = document.querySelector(".lb-toggle-jpeg")?.textContent?.trim() ?? "";
            return { width: canvas?.width ?? 0, height: canvas?.height ?? 0, sourceLabel, banner, toggle };
        });
        mark(`source step ${i + 1}/${steps}: canvas=${state.width}x${state.height} banner="${state.banner}" toggle="${state.toggle}" label="${state.sourceLabel}"`);
    }
}

async function testRun(page: any, label: string, selectedFiles: string[]) {
    mark(`=== ${label} ===`);
    mark(`files: ${formatFiles(selectedFiles)}`);
    await page.goto(APP_URL, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => !!document.getElementById("file-input"), null, { timeout: 30000 });
    await dumpStats(page, `${label} after goto`);

    const fileInput = page.locator("#file-input");
    const start = Date.now();
    mark(`${label} setInputFiles`);
    await fileInput.setInputFiles(selectedFiles);

    await waitForAnyThumbCanvas(page, 1, 120000);
    mark(`${label} first thumb canvas after ${Date.now() - start}ms`);
    await dumpThumbs(page, `${label} first display`);
    await dumpStats(page, `${label} first display`);

    await waitForThumbs(page, selectedFiles.length, 240000);
    mark(`${label} thumbs complete after ${Date.now() - start}ms`);
    await dumpThumbs(page, `${label} complete`);
    await dumpStats(page, `${label} complete`);

    await selectView(page, "rect");
    await selectView(page, "square");
    await selectView(page, "natural");
    await selectView(page, "rect");

    await openLightboxAndReport(page, 0);
    await cycleLightboxSource(page, 3);

    if (selectedFiles.length > 1) {
        await page.locator(".lightbox-next").click({ timeout: 10000 });
        const nextState = await page.evaluate(() => {
            const canvas = document.getElementById("lightbox-canvas") as HTMLCanvasElement | null;
            const banner = document.getElementById("lb-source-banner")?.textContent?.trim() ?? "";
            const label = document.getElementById("lb-source-label")?.textContent?.trim() ?? "";
            return { width: canvas?.width ?? 0, height: canvas?.height ?? 0, banner, label };
        });
        mark(`lightbox next canvas=${nextState.width}x${nextState.height} banner="${nextState.banner}" label="${nextState.label}"`);

        await page.locator(".lightbox-prev").click({ timeout: 10000 });
        const backState = await page.evaluate(() => {
            const canvas = document.getElementById("lightbox-canvas") as HTMLCanvasElement | null;
            const banner = document.getElementById("lb-source-banner")?.textContent?.trim() ?? "";
            const label = document.getElementById("lb-source-label")?.textContent?.trim() ?? "";
            return { width: canvas?.width ?? 0, height: canvas?.height ?? 0, banner, label };
        });
        mark(`lightbox prev canvas=${backState.width}x${backState.height} banner="${backState.banner}" label="${backState.label}"`);
    }

    await page.screenshot({ path: `verify-${label.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.png`, fullPage: true });
    await dumpStats(page, `${label} final`);
}

async function launchBrowser() {
    const cdpPort = process.env.CDP_PORT;
    const cdpUrl = process.env.CDP_URL;
    if (cdpPort || cdpUrl) {
        const endpoint = cdpUrl ?? `http://127.0.0.1:${cdpPort}`;
        mark(`connect over CDP: ${endpoint}`);
        const browser = await chromium.connectOverCDP(endpoint, { timeout: 180_000 });
        const context = await browser.newContext();
        return { handle: browser, context };
    }

    const tmpRoot = join(process.cwd(), "tmp");
    await mkdir(tmpRoot, { recursive: true });
    const userDataDir = await mkdtemp(join(tmpRoot, "pw-"));
    mark(`launch persistent shell: ${BROWSER_PATH}`);
    mark(`user-data-dir: ${userDataDir}`);
    const context = await chromium.launchPersistentContext(userDataDir, {
        executablePath: BROWSER_PATH,
        headless: true,
        timeout: 180_000,
    });
    return { handle: context, context };
}

let browser: any = null;

try {
    const launched = await launchBrowser();
    browser = launched.handle;
    const page = launched.context.pages()[0] ?? await launched.context.newPage();

    page.on("console", (m: any) => {
        const type = m.type();
        if (type === "error" || type === "warning" || type === "log") {
            console.log(`[page-${type}] ${m.text()}`);
        }
    });
    page.on("pageerror", (err: Error) => {
        console.log(`[pageerror] ${err.message}`);
    });
    page.on("requestfailed", (req: any) => {
        console.log(`[netfail] ${req.method()} ${req.url()} ${req.failure()?.errorText ?? ""}`);
    });
    page.on("response", (res: any) => {
        if (res.status() >= 400) {
            console.log(`[http] ${res.status()} ${res.url()}`);
        }
    });

    mark(`app url: ${APP_URL}`);
    await testRun(page, "single-file", [files[0]]);
    await testRun(page, "multi-file", files.slice(0, Math.min(files.length, 3)));

    mark("done");
} catch (err) {
    console.log(`[fatal] ${(err as Error).stack ?? (err as Error).message ?? String(err)}`);
    process.exitCode = 1;
} finally {
    try {
        if (browser) await browser.close();
    } catch (err) {
        console.log(`[browser-close] ${(err as Error).message ?? String(err)}`);
    }
}
