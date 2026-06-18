# Hardware Telemetry Integration Guide

Reusable hardware monitoring across all benchmark tests via LibreHardwareMonitor.

## Available Metrics

```
CPU:     clock speed, load%, voltage, power, temperature, fan RPM/duty
GPU:     clock, memory clock, load%, power, VRAM usage, temperature
System:  total power draw, storage temperature
```

## Quick Integration

### 1. Import the module
```javascript
import { collectHardwareTelemetry, formatTelemetryReport, toToonMetrics } from './benchmark/hardware-telemetry.mjs';
```

### 2. Collect at test start
```javascript
const telemetry = collectHardwareTelemetry();
console.log(formatTelemetryReport(telemetry)); // pretty output
```

### 3. Add to TOON/JSON output
```javascript
const metrics = toToonMetrics(telemetry);
toonLines.push("# Hardware Telemetry");
Object.entries(metrics).forEach(([key, val]) => {
  toonLines.push(`${key}: ${val}`);
});
```

## Functions

### `collectHardwareTelemetry()`
Returns object with all available metrics from LibreHardwareMonitor. Falls back gracefully if not installed.

### `formatTelemetryReport(telemetry, compact=false)`
Pretty-print telemetry. `compact=true` gives single-line format for console output.

### `toToonMetrics(telemetry)`
Returns flat object suitable for TOON file metrics section.

## Test Files Using This

- StandardMultifileTest.mjs (main benchmark)
- timing-tests.mjs (via ENV override)
- progressive-timing-benchmark.mjs (via ENV override)
- All test_N_*.mjs sweep tests (one import at top)

## Requirements

- **Windows only** (via WMI)
- LibreHardwareMonitor installed (gracefully skipped if missing)
- PowerShell 5.0+

## Metric Availability

| Metric | Source | Fallback |
|--------|--------|----------|
| CPU load/clock/temp | WMI + CIM | CIM only |
| CPU voltage/power/fan | LibreHardwareMonitor WMI | N/A |
| GPU metrics | LibreHardwareMonitor WMI | N/A |
| System power | LibreHardwareMonitor WMI | N/A |
| Storage temp | LibreHardwareMonitor WMI | N/A |

All metrics default to `'N/A'` if sensor not available.

## Example: timing-tests.mjs

```javascript
import { collectHardwareTelemetry, formatTelemetryReport, toToonMetrics } from './hardware-telemetry.mjs';

// At main() start
const telemetry = collectHardwareTelemetry();
console.log('\n' + formatTelemetryReport(telemetry, true));

// In TOON output
toonLines.push("", "# Hardware Telemetry");
const hwMetrics = toToonMetrics(telemetry);
Object.entries(hwMetrics).forEach(([key, val]) => {
  toonLines.push(`${key}: ${val}`);
});
```

## Example: test_N_*.mjs (sweep tests)

```javascript
import { collectHardwareTelemetry, formatTelemetryReport } from './hardware-telemetry.mjs';

async function main() {
  const telemetry = collectHardwareTelemetry();
  const hw = formatTelemetryReport(telemetry, true);
  console.log(`Test: ${hw}`);
  
  // ... benchmark loop ...
  
  // Optionally report per-iteration if overheating
  if (parseFloat(telemetry.cpuTemperatureCelsius) > 85) {
    console.warn(`⚠️ High CPU temp: ${telemetry.cpuTemperatureCelsius}°C`);
  }
}
```
