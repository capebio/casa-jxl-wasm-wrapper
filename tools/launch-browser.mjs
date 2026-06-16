import { existsSync } from "node:fs";
import { readdir, stat, rm, mkdir, mkdtemp, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoDir = join(__dirname, "..");
const tmpBaseDir = join(repoDir, "tmp");

// Helper to remove directory with retry on Windows file lock
async function rmWithRetry(dir) {
    for (let i = 0; i < 3; i++) {
        try {
            await rm(dir, { recursive: true, force: true });
            return;
        } catch (e) {
            await delay(500);
        }
    }
}

// X-1: Browser path resolution
export async function resolveBrowserPath() {
    // 1. Env override
    if (process.env.BROWSER_PATH) {
        console.log(`[launch-browser] Resolved browser path via env BROWSER_PATH: ${process.env.BROWSER_PATH}`);
        return process.env.BROWSER_PATH;
    }

    // 2. Playwright's own registry
    try {
        const { chromium } = await import("playwright");
        const p = chromium.executablePath();
        if (p) {
            console.log(`[launch-browser] Resolved browser path via Playwright registry: ${p}`);
            return p;
        }
    } catch (e) {
        // Ignore and proceed to next step
    }

    // 3. Scan ms-playwright cache for newest chromium_headless_shell-*
    try {
        let msPlaywrightDir;
        if (process.platform === "win32") {
            const localAppData = process.env.LOCALAPPDATA || (process.env.USERPROFILE ? join(process.env.USERPROFILE, "AppData", "Local") : null);
            if (localAppData) {
                msPlaywrightDir = join(localAppData, "ms-playwright");
            }
        } else if (process.platform === "darwin") {
            if (process.env.HOME) {
                msPlaywrightDir = join(process.env.HOME, "Library", "Caches", "ms-playwright");
            }
        } else {
            // Linux or other
            const cacheHome = process.env.XDG_CACHE_HOME || (process.env.HOME ? join(process.env.HOME, ".cache") : null);
            if (cacheHome) {
                msPlaywrightDir = join(cacheHome, "ms-playwright");
            }
        }

        if (msPlaywrightDir && existsSync(msPlaywrightDir)) {
            const dirs = await readdir(msPlaywrightDir);
            const matches = dirs.filter(name => name.startsWith("chromium_headless_shell-"));
            matches.sort((a, b) => {
                const verA = parseInt(a.replace("chromium_headless_shell-", ""), 10) || 0;
                const verB = parseInt(b.replace("chromium_headless_shell-", ""), 10) || 0;
                return verB - verA; // descending
            });

            let executableRelativePaths = [];
            if (process.platform === "win32") {
                executableRelativePaths = ["chrome-headless-shell-win64/chrome-headless-shell.exe", "chrome-headless-shell-win32/chrome-headless-shell.exe"];
            } else if (process.platform === "darwin") {
                executableRelativePaths = [
                    "chrome-headless-shell-mac-x64/chrome-headless-shell",
                    "chrome-headless-shell-mac-arm64/chrome-headless-shell"
                ];
            } else {
                executableRelativePaths = ["chrome-headless-shell-linux64/chrome-headless-shell"];
            }

            for (const match of matches) {
                const dirPath = join(msPlaywrightDir, match);
                for (const relPath of executableRelativePaths) {
                    const fullPath = join(dirPath, relPath);
                    if (existsSync(fullPath)) {
                        console.log(`[launch-browser] Resolved browser path via ms-playwright scan (${match}): ${fullPath}`);
                        return fullPath;
                    }
                }
            }
        }
    } catch (e) {
        // Ignore and proceed to fallback
    }

    // 4. Real Chrome fallback on Windows
    if (process.platform === "win32") {
        const realChromePaths = [
            "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
            "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"
        ];
        for (const p of realChromePaths) {
            if (existsSync(p)) {
                console.log(`[launch-browser] Resolved browser path via Windows Real Chrome fallback: ${p}`);
                return p;
            }
        }
    }

    throw new Error("no browser found; set BROWSER_PATH");
}

// Read manual-spawn port and ws path from DevToolsActivePort file
async function readDevToolsEndpoint(userDataDir, deadlineMs = 30000) {
    const deadline = Date.now() + deadlineMs;
    while (Date.now() < deadline) {
        try {
            const txt = await readFile(join(userDataDir, "DevToolsActivePort"), "utf8");
            const lines = txt.split(/\r?\n/);
            const port = lines[0]?.trim();
            const wsPath = lines[1]?.trim();
            if (port && wsPath) {
                return `ws://127.0.0.1:${port}${wsPath}`;
            }
        } catch {}
        await delay(100);
    }
    throw new Error("DevToolsActivePort not ready");
}

// Watchdog helper for Strategy 3
async function launchPersistentWithWatchdog(userDataDir, options, timeoutMs = 150000) {
    let timer;
    const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => {
            reject(new Error("watchdog_timeout"));
        }, timeoutMs);
    });

    try {
        const { chromium } = await import("playwright");
        const context = await Promise.race([
            chromium.launchPersistentContext(userDataDir, options),
            timeoutPromise
        ]);
        clearTimeout(timer);
        return context;
    } catch (err) {
        clearTimeout(timer);
        throw err;
    }
}

// Strategy 2 launcher
async function launchStrategy2({ headless = true, timeoutMs = 180000 } = {}) {
    const { chromium } = await import("playwright");
    const browserPath = await resolveBrowserPath();
    await mkdir(tmpBaseDir, { recursive: true });
    const userDataDir = await mkdtemp(join(tmpBaseDir, "pw-profile-"));

    console.log(`[launch-browser] Strategy 2: Spawning browser manually on port 0...`);
    const proc = spawn(browserPath, [
        headless ? "--headless=new" : "",
        "--remote-debugging-port=0",
        `--user-data-dir=${userDataDir}`,
        "about:blank"
    ].filter(Boolean), {
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true
    });

    // Prevent blocking on filled stderr pipe (N-1)
    proc.stderr.on("data", () => {});

    try {
        const wsUrl = await readDevToolsEndpoint(userDataDir, timeoutMs);
        console.log(`[launch-browser] Strategy 2: Connecting over CDP to wsUrl: ${wsUrl}`);
        const browser = await chromium.connectOverCDP(wsUrl, { timeout: timeoutMs });
        
        const contexts = browser.contexts();
        let context;
        if (contexts.length > 0) {
            context = contexts[0];
        } else {
            context = await browser.newContext();
        }
        const page = (await context.pages())[0] || (await context.newPage());

        const close = async () => {
            try {
                await browser.close().catch(() => {});
            } catch {}

            const exited = new Promise((resolve) => {
                if (proc.killed || proc.exitCode !== null) {
                    resolve(true);
                } else {
                    proc.once("exit", () => resolve(true));
                }
            });

            try {
                proc.kill();
            } catch {}

            const done = await Promise.race([
                exited,
                delay(5000).then(() => "timeout")
            ]);

            if (done === "timeout" && process.platform === "win32") {
                try {
                    const { spawn: spawnSync } = await import("node:child_process");
                    spawnSync("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
                } catch (err) {
                    console.error("[launch-browser] taskkill failed:", err);
                }
            }

            await rmWithRetry(userDataDir);
        };

        return { context, page, kind: "spawn", close, userDataDir };
    } catch (err) {
        try { proc.kill(); } catch {}
        await rmWithRetry(userDataDir).catch(() => {});
        throw err;
    }
}

// X-2: Strategy-chain launch()
export async function launch({ headless = true, timeoutMs = 180000 } = {}) {
    const { chromium } = await import("playwright");

    // Strategy 1: CDP_URL or CDP_PORT set in env → connectOverCDP
    if (process.env.CDP_URL || process.env.CDP_PORT) {
        let endpoint = process.env.CDP_URL;
        if (!endpoint && process.env.CDP_PORT) {
            endpoint = `http://127.0.0.1:${process.env.CDP_PORT}`;
        }
        console.log(`[launch-browser] Strategy 1: Connecting over CDP to ${endpoint}`);
        const browser = await chromium.connectOverCDP(endpoint, { timeout: timeoutMs });
        const context = await browser.newContext();
        const page = await context.newPage();
        
        const close = async () => {
            await context.close().catch(() => {});
            await browser.close().catch(() => {});
        };

        return { context, page, kind: "cdp", close };
    }

    // If SPAWN_CDP=1 is set, skip Strategy 3 and use Strategy 2 directly
    if (process.env.SPAWN_CDP === "1") {
        console.log("[launch-browser] Strategy 2 forced by SPAWN_CDP=1 env variable");
        return await launchStrategy2({ headless, timeoutMs });
    }

    // Strategy 3: launchPersistentContext wrapped in 30s watchdog (was 150s for faster fallback)
    await mkdir(tmpBaseDir, { recursive: true });
    const userDataDir = await mkdtemp(join(tmpBaseDir, "pw-profile-"));
    const browserPath = await resolveBrowserPath();

    console.log(`[launch-browser] Strategy 3: Launching persistent context at ${userDataDir}`);
    try {
        const context = await launchPersistentWithWatchdog(userDataDir, {
            executablePath: browserPath,
            headless
        }, 30000);

        const pages = context.pages();
        const page = pages[0] || (await context.newPage());

        const close = async () => {
            await context.close().catch(() => {});
            await rmWithRetry(userDataDir);
        };

        return { context, page, kind: "persistent", close, userDataDir };
    } catch (err) {
        console.warn("[launch-browser] Strategy 3 failed or timed out. Falling back to Strategy 2. Error:", err);
        // Clean up Strategy 3 temp dir immediately
        await rmWithRetry(userDataDir).catch(() => {});
        // Fallback
        return await launchStrategy2({ headless, timeoutMs });
    }
}

// X-3: Temp-dir sweep policy (older than 24h)
async function sweepOldProfiles() {
    try {
        if (!existsSync(tmpBaseDir)) return;
        const dirs = await readdir(tmpBaseDir).catch(() => []);
        const now = Date.now();
        const threshold = 24 * 60 * 60 * 1000; // 24 hours
        for (const name of dirs) {
            if (name.startsWith("pw-profile-")) {
                const fullPath = join(tmpBaseDir, name);
                try {
                    const s = await stat(fullPath);
                    if (now - s.mtimeMs > threshold) {
                        await rm(fullPath, { recursive: true, force: true }).catch(() => {});
                    }
                } catch {}
            }
        }
    } catch (err) {
        // Safe no-op to prevent module import failure
    }
}

// Sweep on load
sweepOldProfiles().catch(() => {});

// Acceptance: Self-test runner
if (process.argv.includes("--self-test")) {
    console.log("[launch-browser self-test] Starting self-test...");
    try {
        console.log("[launch-browser self-test] 1. Resolving browser path...");
        const path = await resolveBrowserPath();
        console.log(`[launch-browser self-test] Path resolved: ${path}`);

        console.log("[launch-browser self-test] 2. Launching via Strategy 3...");
        const launched = await launch({ headless: true });
        console.log(`[launch-browser self-test] Launched successfully! Kind: ${launched.kind}`);
        
        if (!launched.userDataDir) {
            throw new Error("userDataDir should be returned for Strategy 3");
        }
        console.log(`[launch-browser self-test] Profile directory: ${launched.userDataDir}`);
        if (!existsSync(launched.userDataDir)) {
            throw new Error(`Temp directory does not exist on disk: ${launched.userDataDir}`);
        }

        console.log("[launch-browser self-test] 3. Creating page and navigating to about:blank...");
        const page = launched.page || (await launched.context.newPage());
        await page.goto("about:blank");
        console.log(`[launch-browser self-test] Page navigated successfully. Title: "${await page.title()}"`);

        console.log("[launch-browser self-test] 4. Closing browser and checking temp directory cleanup...");
        const tempDir = launched.userDataDir;
        await launched.close();
        console.log("[launch-browser self-test] Close resolved. Checking if temp dir is gone...");

        if (existsSync(tempDir)) {
            throw new Error(`Temp directory still exists after close(): ${tempDir}`);
        }
        console.log("[launch-browser self-test] Verified: Temp directory successfully deleted!");

        console.log("[launch-browser self-test] Self-test PASSED successfully!");
        process.exit(0);
    } catch (err) {
        console.error("[launch-browser self-test] Self-test FAILED:", err);
        process.exit(1);
    }
}
