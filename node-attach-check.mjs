import { chromium } from "playwright";

const PORT = Number(process.env.CDP_PORT ?? 9444);
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`, { timeout: 120000 });
console.log("connected");
await browser.close();
