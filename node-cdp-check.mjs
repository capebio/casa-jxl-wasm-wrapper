import { chromium } from "playwright";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const BROWSER_PATH = String.raw`C:\Users\User\AppData\Local\ms-playwright\chromium_headless_shell-1217\chrome-headless-shell-win64\chrome-headless-shell.exe`;
const PORT = 9444;

async function pollReady() {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (res.ok) return await res.json();
    } catch {}
    await delay(250);
  }
  throw new Error("cdp not ready");
}

const tmp = await mkdtemp(join(process.cwd(), "node-cdp-"));
const proc = spawn(BROWSER_PATH, [
  "--headless=new",
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${tmp}`,
  "about:blank",
], {
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
proc.on("exit", (code, signal) => {
  console.log(`exit code=${code} signal=${signal}`);
});
proc.stderr.on("data", (chunk) => {
  process.stdout.write(String(chunk));
});

try {
  const version = await pollReady();
  console.log(version.webSocketDebuggerUrl);
  const browser = await chromium.connectOverCDP(version.webSocketDebuggerUrl, { timeout: 30000 });
  console.log("connected");
  await browser.close();
} finally {
  proc.kill();
}
