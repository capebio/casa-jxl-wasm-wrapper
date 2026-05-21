import { chromium } from "playwright";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";

const BROWSER = String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`;
const userDataDir = await mkdtemp(join(process.cwd(), "bun-chrome-"));
const context = await chromium.launchPersistentContext(userDataDir, {
  executablePath: BROWSER,
  headless: true,
  timeout: 120000,
});
console.log("pages", context.pages().length);
await context.close();
