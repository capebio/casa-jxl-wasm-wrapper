import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

export const GRAPH_BROWSER_LAUNCH_METHODS = [
  {
    id: "direct-spawn",
    launchId: 1,
    label: "Launch 1",
    description: "Direct browser spawn",
  },
  {
    id: "cmd-start",
    launchId: 2,
    label: "Launch 2",
    description: "cmd /c start",
  },
  {
    id: "explorer",
    launchId: 3,
    label: "Launch 3",
    description: "explorer.exe",
  },
  {
    id: "rundll32",
    launchId: 4,
    label: "Launch 4",
    description: "rundll32 url.dll,FileProtocolHandler",
  },
  {
    id: "probe-data",
    launchId: 5,
    label: "Launch 5",
    description: "data: probe page",
  },
];

function normalizeLaunchMethodId(methodId) {
  return GRAPH_BROWSER_LAUNCH_METHODS.find((method) => method.id === methodId) ? methodId : null;
}

function readJsonFile(path) {
  if (!path || !existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function writeJsonFile(path, value) {
  if (!path) return;
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function chooseGraphBrowser({ chromePath = null, edgePath = null, bravePath = null } = {}) {
  if (chromePath) return { name: "chrome", path: chromePath };
  if (edgePath) return { name: "edge", path: edgePath };
  if (bravePath) return { name: "brave", path: bravePath };
  return { name: "system", path: null };
}

export function getNextGraphBrowserLaunchMethod({ statePath, overrideMethodId = null } = {}) {
  const forcedMethodId = normalizeLaunchMethodId(overrideMethodId);
  if (forcedMethodId) {
    const method = GRAPH_BROWSER_LAUNCH_METHODS.find((entry) => entry.id === forcedMethodId);
    return { method, state: null, override: true };
  }

  const state = readJsonFile(statePath) || { nextIndex: 0 };
  const index = Number.isInteger(state.nextIndex) ? state.nextIndex : 0;
  const method = GRAPH_BROWSER_LAUNCH_METHODS[index % GRAPH_BROWSER_LAUNCH_METHODS.length];
  const nextState = { nextIndex: (index + 1) % GRAPH_BROWSER_LAUNCH_METHODS.length };
  writeJsonFile(statePath, nextState);
  return { method, state: nextState, override: false };
}

export function buildGraphBrowserLaunchPlan({ methodId, browserPath, filePath }) {
  const cleanPath = String(filePath || "");
  const fileUrl = pathToFileURL(cleanPath).href;
  const profileDir = mkdtempSync(join(tmpdir(), `raw-converter-graph-browser-${methodId}-`));

  switch (methodId) {
    case "direct-spawn":
      // Use file:// URL + flags that help large local self-contained HTML/JS apps
      // (inline JSON + heavy SVG) open reliably.
      const isChromium = /chrome|edge|brave|msedge/i.test(String(browserPath || ""));
      const extraFlags = isChromium ? ["--allow-file-access-from-files", "--disable-web-security"] : [];
      return {
        browserPath,
        args: [
          "--new-window",
          "--disable-extensions",
          "--disable-gpu",
          "--no-first-run",
          "--no-default-browser-check",
          `--user-data-dir=${profileDir}`,
          ...extraFlags,
          fileUrl,
        ],
        options: {
          detached: true,
          stdio: "ignore",
          shell: false,
        },
      };
    case "cmd-start":
      return {
        browserPath: "cmd.exe",
        args: ["/c", "start", "", cleanPath],
        options: {
          detached: true,
          stdio: "ignore",
          shell: false,
        },
      };
    case "explorer":
      return {
        browserPath: "explorer.exe",
        args: [cleanPath],
        options: {
          detached: true,
          stdio: "ignore",
          shell: false,
        },
      };
    case "rundll32":
      return {
        browserPath: "rundll32.exe",
        args: ["url.dll,FileProtocolHandler", cleanPath],
        options: {
          detached: true,
          stdio: "ignore",
          shell: false,
        },
      };
    case "probe-data": {
      const launchText = `Launch 5 - data probe`;
      const dataHtml = `<!doctype html><html><head><meta charset="utf-8"><title>${launchText}</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:700 44px/1.1 Segoe UI,system-ui,sans-serif;background:#07131a;color:#d7f5ff} .card{padding:28px 34px;border-radius:20px;background:rgba(9,20,28,.92);border:1px solid rgba(141,227,255,.24);box-shadow:0 20px 50px rgba(0,0,0,.35);text-align:center} .sub{margin-top:10px;font-size:18px;color:#92a9b5;font-weight:500}</style></head><body><div class="card">${launchText}<div class="sub">If this breaks, browser startup is the problem.</div></div></body></html>`;
      return {
        browserPath,
        args: [
          "--new-window",
          "--disable-extensions",
          "--disable-gpu",
          "--no-first-run",
          "--no-default-browser-check",
          `--user-data-dir=${profileDir}`,
          `data:text/html;charset=utf-8,${encodeURIComponent(dataHtml)}`,
        ],
        options: {
          detached: true,
          stdio: "ignore",
          shell: false,
        },
      };
    }
    default:
      return buildGraphBrowserLaunchPlan({ methodId: "direct-spawn", browserPath, filePath });
  }
}
