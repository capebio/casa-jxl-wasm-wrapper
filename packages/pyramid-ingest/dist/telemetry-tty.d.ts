import type { Telemetry } from "./backends.js";
export declare const noOpTelemetry: Telemetry;
/** Human-facing renderer. Selected by --verbose.
 *  - TTY-1: all status goes to STDERR so stdout stays machine-clean (--json / pipes).
 *  - TTY-2: TTY-aware — uses \r only on a real terminal, else emits plain progress lines.
 *  - TTY-3: stages print when `showStages` (passed from -vv) or VERBOSE/DEBUG env is set.
 *  - TTY-4: redraws throttled to ~10fps, line width-clamped, with rate/ETA.
 */
export declare function createTtyTelemetry(opts?: {
    showStages?: boolean;
}): Telemetry;
//# sourceMappingURL=telemetry-tty.d.ts.map