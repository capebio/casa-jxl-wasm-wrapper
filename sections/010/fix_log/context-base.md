# Fix Log — context-base.ts (Section 010)

## Finding
**L129-144 (LOW):** `probeCapabilities()` swallowed all errors silently. A capability probe
failure was invisible — no log, no signal — making capability regressions undiagnosable.

## Fix Applied
**File:** `packages/jxl-session/src/context-base.ts`  
**Change:** `catch { ... }` → `catch (e) { console.warn("[jxl-session] probeCapabilities failed (using defaults):", e); }`

Matches the existing non-fatal warning pattern used in `decode-session.ts`
(`console.warn(\`[jxl-session] onMetric threw\`, e)`).

Probe semantics unchanged: failure is still best-effort (caller does not observe the error;
conservative `defaultCapabilities()` remains in effect).

## Verification
`npm run typecheck` in `packages/jxl-session` → **EXIT 0** (clean).

## Deferrals
None for this finding.
