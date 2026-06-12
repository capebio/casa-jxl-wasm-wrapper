import { launch } from "./tools/launch-browser.mjs";

const watchdog = setTimeout(() => {
  console.error("FAIL: watchdog timeout triggered");
  process.exit(2);
}, 150_000);

try {
  const t0 = Date.now();
  const { context, close } = await launch({ headless: true });
  const pages = context.pages().length;
  console.log(`PASS pages=${pages} chrome=? elapsedMs=${Date.now() - t0}`);
  clearTimeout(watchdog);
  await close();
} catch (err) {
  clearTimeout(watchdog);
  console.error("Caught error in check script:", err);
  process.exitCode = 1;
}
