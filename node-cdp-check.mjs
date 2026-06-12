import { launch } from "./tools/launch-browser.mjs";

try {
  process.env.SPAWN_CDP = "1"; // Force Strategy 2
  const t0 = Date.now();
  const { close } = await launch({ headless: true });
  console.log(`PASS ws=? elapsedMs=${Date.now() - t0}`);
  await close();
} catch (err) {
  console.error(`FAIL: ${err.message}`);
  process.exitCode = 1;
}
