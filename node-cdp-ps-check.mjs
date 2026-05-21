import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const PORT = 9666;
const BROWSER = String.raw`C:\Users\User\AppData\Local\ms-playwright\chromium_headless_shell-1217\chrome-headless-shell-win64\chrome-headless-shell.exe`;
const tmp = await mkdtemp(join(process.cwd(), "node-ps-cdp-"));

const psScript = [
  `Start-Process -FilePath '${BROWSER}'`,
  `-ArgumentList @('--headless=new','--remote-debugging-port=${PORT}','--user-data-dir=${tmp}','about:blank')`,
  `-WindowStyle Hidden`,
].join(" ");

const ps = spawn("powershell.exe", ["-NoProfile", "-Command", psScript], {
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
ps.stdout.on("data", (c) => process.stdout.write(String(c)));
ps.stderr.on("data", (c) => process.stdout.write(String(c)));
ps.on("exit", (code, signal) => console.log(`ps exit ${code} ${signal}`));

async function waitJson(path, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}${path}`);
      if (res.ok) return await res.json();
    } catch {}
    await delay(500);
  }
  throw new Error(`timeout waiting for ${path}`);
}

const version = await waitJson("/json/version");
console.log("version ok");
const list = await waitJson("/json/list");
console.log(`targets=${list.length}`);
const browser = await chromium.connectOverCDP(version.webSocketDebuggerUrl, { timeout: 120000 });
console.log("connected");
console.log(`contexts=${browser.contexts().length}`);
await browser.close();
