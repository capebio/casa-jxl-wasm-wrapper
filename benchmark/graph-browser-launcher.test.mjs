import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  GRAPH_BROWSER_LAUNCH_METHODS,
  chooseGraphBrowser,
  buildGraphBrowserLaunchPlan,
  getNextGraphBrowserLaunchMethod,
} from "./graph-browser-launcher.mjs";

test("graph browser launcher prefers chrome over brave", () => {
  const browser = chooseGraphBrowser({
    chromePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    edgePath: null,
    bravePath: "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
  });

  assert.equal(browser.name, "chrome");
  assert.equal(browser.path, "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe");
});

test("graph browser launch plan opens a local file in the selected browser", () => {
  const plan = buildGraphBrowserLaunchPlan({
    methodId: "direct-spawn",
    browserPath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    filePath: "C:\\Foo\\raw-converter-wasm\\docs\\outputs\\timing tests\\GraphAggregateResults.html",
  });

  assert.equal(plan.browserPath, "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe");
  assert.match(plan.args.join(" "), /GraphAggregateResults\.html/);
  assert.match(plan.args.join(" "), /--user-data-dir/);
  assert.match(plan.args.join(" "), /--disable-extensions/);
  assert.equal(plan.options.detached, true);
  assert.equal(plan.options.shell, false);
});

test("graph browser launch methods cycle and persist", () => {
  const dir = mkdtempSync(join(tmpdir(), "raw-converter-launch-"));
  const statePath = join(dir, "state.json");

  const first = getNextGraphBrowserLaunchMethod({ statePath });
  const second = getNextGraphBrowserLaunchMethod({ statePath });
  const third = getNextGraphBrowserLaunchMethod({ statePath });
  const fourth = getNextGraphBrowserLaunchMethod({ statePath });
  const fifth = getNextGraphBrowserLaunchMethod({ statePath });
  const sixth = getNextGraphBrowserLaunchMethod({ statePath });

  assert.equal(first.method.id, GRAPH_BROWSER_LAUNCH_METHODS[0].id);
  assert.equal(second.method.id, GRAPH_BROWSER_LAUNCH_METHODS[1].id);
  assert.equal(third.method.id, GRAPH_BROWSER_LAUNCH_METHODS[2].id);
  assert.equal(fourth.method.id, GRAPH_BROWSER_LAUNCH_METHODS[3].id);
  assert.equal(fifth.method.id, GRAPH_BROWSER_LAUNCH_METHODS[4].id);
  assert.equal(sixth.method.id, GRAPH_BROWSER_LAUNCH_METHODS[0].id);
  assert.match(readFileSync(statePath, "utf8"), /nextIndex/);
});

test("graph browser launch methods can be forced", () => {
  const dir = mkdtempSync(join(tmpdir(), "raw-converter-launch-force-"));
  const statePath = join(dir, "state.json");
  const forced = getNextGraphBrowserLaunchMethod({ statePath, overrideMethodId: "rundll32" });

  assert.equal(forced.method.id, "rundll32");
  assert.equal(forced.override, true);
});

test("graph browser probe-data plan uses a data url", () => {
  const plan = buildGraphBrowserLaunchPlan({
    methodId: "probe-data",
    browserPath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    filePath: "C:\\Foo\\raw-converter-wasm\\docs\\outputs\\timing tests\\GraphAggregateResults.html",
  });

  assert.equal(plan.browserPath, "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe");
  assert.match(plan.args.join(" "), /data:text\/html/);
  assert.match(plan.args.join(" "), /Launch%205/);
});
