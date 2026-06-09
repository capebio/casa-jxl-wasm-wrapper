import type { Telemetry } from "./backends.js";

export const noOpTelemetry: Telemetry = {
  stage() {},
  progress() {},
};

export function createTtyTelemetry(): Telemetry {
  let last = "";
  return {
    stage(name: string, fields?: Record<string, unknown>) {
      if (process.env.VERBOSE || process.env.DEBUG) {
        const f = fields ? " " + JSON.stringify(fields) : "";
        process.stdout.write(`[stage] ${name}${f}\n`);
      }
    },
    progress(done: number, total: number, currentItem?: string) {
      const pct = total > 0 ? Math.floor((done / total) * 100) : 0;
      const cur = currentItem ? ` ${currentItem}` : "";
      const line = `\r${pct}% (${done}/${total})${cur}`;
      if (line !== last) {
        process.stdout.write(line);
        last = line;
      }
      if (done >= total && total > 0) {
        process.stdout.write("\n");
        last = "";
      }
    },
  };
}
