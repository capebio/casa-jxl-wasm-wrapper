# ADR: Add optional structured diagnostic channel to getCapabilities (errors-7)

**Status:** Draft  
**File:** packages/jxl-capabilities/src/index.ts:60-83  
**Severity:** info

## Context

All four `_probe*` functions plus the native-module import use silent `catch {}`. In production it is impossible to distinguish "SIMD disabled by browser flag" from "WebAssembly.validate threw unexpectedly". Operators cannot diagnose why capabilities detection returns all-false.

## Decision

Add an optional `onDiagnostic?: (event: CapabilityDiagnostic) => void` parameter to `getCapabilities()` (or as a separate `setDiagnosticListener()` setter to avoid breaking the current zero-arg call).

```typescript
export interface CapabilityDiagnostic {
  probe: "simd" | "relaxed-simd" | "wasm-threads" | "wasm-exceptions" | "native-jxl" | "wasm-presence";
  result: boolean | null;
  error?: unknown;
}
```

In each probe function, pass the diagnostic to a module-level `_diagnosticListener` if set:

```typescript
let _diagnosticListener: ((d: CapabilityDiagnostic) => void) | undefined;

export function setCapabilityDiagnosticListener(fn: typeof _diagnosticListener): void {
  _diagnosticListener = fn;
}
```

## Consequences

- Zero cost when `_diagnosticListener` is not set (production default).
- Does not change the existing `getCapabilities()` call signature.
- Callers can wire in `console.warn` or Sentry-style telemetry for CSP/environment debugging.
- Requires passing the listener into the probe functions (or reading the module-level variable), both of which are simple.
- The `_resetCache()` test helper should also clear `_diagnosticListener` to prevent test pollution.
