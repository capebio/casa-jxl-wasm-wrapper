import { execFileSync } from "node:child_process";
import process from "node:process";

const task = process.argv[2];
if (!task) {
  throw new Error("usage: node tools/run-workspaces.mjs <build|typecheck|test>");
}

const workspaceOrder = {
  build: [
    "@casabio/jxl-core",
    "@casabio/jxl-capabilities",
    "@casabio/jxl-policy",
    "@casabio/jxl-cache",
    "@casabio/jxl-scheduler",
    "@casabio/jxl-wasm",
    "@casabio/jxl-worker-browser",
    "@casabio/jxl-worker-node",
    "@casabio/jxl-stream",
    "@casabio/jxl-session",
    "@casabio/jxl-test-corpus",
  ],
  typecheck: [
    "@casabio/jxl-core",
    "@casabio/jxl-capabilities",
    "@casabio/jxl-policy",
    "@casabio/jxl-cache",
    "@casabio/jxl-native",
    "@casabio/jxl-scheduler",
    "@casabio/jxl-wasm",
    "@casabio/jxl-worker-browser",
    "@casabio/jxl-worker-node",
    "@casabio/jxl-stream",
    "@casabio/jxl-session",
    "@casabio/jxl-test-corpus",
  ],
  test: [
    "@casabio/jxl-scheduler",
    "@casabio/jxl-worker-browser",
    "@casabio/jxl-worker-node",
    "@casabio/jxl-stream",
    "@casabio/jxl-session",
  ],
};

const packages = workspaceOrder[task];
if (!packages) {
  throw new Error(`unknown workspace task: ${task}`);
}

function runNpm(args) {
  const npmCli = process.env.npm_execpath;
  if (npmCli) {
    execFileSync(process.execPath, [npmCli, ...args], { stdio: "inherit" });
    return;
  }
  execFileSync("cmd.exe", ["/d", "/s", "/c", "npm", ...args], { stdio: "inherit" });
}

for (const name of packages) {
  console.log(`>> ${task} ${name}`);
  runNpm(["run", task, "--workspace", name, "--if-present"]);
}
