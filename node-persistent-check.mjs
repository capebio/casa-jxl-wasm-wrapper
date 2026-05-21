import { chromium } from "playwright";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";

const BROWSER = String.raw`C:\Users\User\AppData\Local\ms-playwright\chromium_headless_shell-1217\chrome-headless-shell-win64\chrome-headless-shell.exe`;
const userDataDir = await mkdtemp(join(process.cwd(), "node-persist-"));
const context = await chromium.launchPersistentContext(userDataDir, {
  executablePath: BROWSER,
  headless: true,
  timeout: 120000,
});
console.log("pages", context.pages().length);
await context.close();
