# Hardware Telemetry & LibreHardwareMonitor Integration

Comprehensive CPU/GPU/System metrics collection for benchmark tests using Windows WMI + LibreHardwareMonitor.

## What's New

### Files Added
- **`hardware-telemetry.mjs`** — Shared utility module (reusable, zero deps)
- **`TELEMETRY_INTEGRATION.md`** — Integration guide
- **`TELEMETRY_INTEGRATION_EXAMPLES.md`** — Copy-paste examples

### Files Updated
- **`StandardMultifileTest.mjs`** — Now uses shared telemetry module with expanded metrics

## Available Metrics

### CPU
- **Clock:** Current (GHz) + Max (GHz)
- **Load:** Active load percentage
- **Thermal:** Package temperature (°C)
- **Power:** Power draw (W)
- **Voltage:** Core voltage (mV)
- **Cooling:** Fan RPM + duty cycle (%)
- **State:** Throttling state (Optimal / Throttled)

### GPU
- **Clock:** Core + Memory MHz
- **Load:** GPU load percentage
- **Memory:** Used MB + Total MB
- **Thermal:** Temperature (°C)
- **Power:** Power draw (W)

### System
- **Power:** Total system power (W)
- **Storage:** HDD/SSD temperature (°C)

### All metrics gracefully fallback to `'N/A'` if sensor unavailable.

## Quick Start

### 1. Use in any test
```javascript
import { collectHardwareTelemetry, formatTelemetryReport } from './benchmark/hardware-telemetry.mjs';

const telemetry = collectHardwareTelemetry();
console.log(formatTelemetryReport(telemetry));
```

### 2. Add to TOON output
```javascript
import { toToonMetrics } from './benchmark/hardware-telemetry.mjs';

const metrics = toToonMetrics(telemetry);
toonLines.push('# Hardware Telemetry');
Object.entries(metrics).forEach(([k, v]) => toonLines.push(`${k}: ${v}`));
```

## Requirements

- **Windows only** (via WMI)
- PowerShell 5.0+
- LibreHardwareMonitor installed (optional; graceful fallback if missing)

## Metric Collection

| Source | Metrics | Requires |
|--------|---------|----------|
| Windows CIM | CPU clock, load, throttling | Always available |
| LibreHardwareMonitor WMI | Everything else (GPU, power, voltage, fans, temps) | Optional |

## Example Output

```
🧠 Memory: 16.2GB free / 32.0GB total
📦 Node Heap: 245.6MB active
🔥 CPU: 4.20/5.10 GHz | Load: 38% | Throttle: Optimal
🌡️ CPU Temp: 62.3°C | Fan: 1850 RPM (65%)
⚡ Power: CPU=45.2W | GPU=N/A | System=120.5W
🎮 GPU: Core=2150 MHz | Mem=6800 MHz | Load=0% | 45.0°C
    VRAM: 2048MB / 8192MB
```

## TOON Output

When added to TOON files, metrics appear as:

```
# Hardware Telemetry
CpuLoadPct: 38%
CpuClockCurrentGhz: 4.20
CpuTemperatureCelsius: 62.3
CpuPowerW: 45.2
SystemPowerW: 120.5
GpuClockMhz: 2150
... etc
```

## Thermal Drift Detection

Use for catching throttling during long benchmarks:

```javascript
const start = collectHardwareTelemetry();
// ... run benchmark ...
const end = collectHardwareTelemetry();

const tempDrift = parseFloat(end.cpuTemperatureCelsius) - parseFloat(start.cpuTemperatureCelsius);
if (tempDrift > 10 && end.cpuThrottlingState.includes('Throttled')) {
  console.warn(`⚠️ Thermal drift: +${tempDrift}°C, throttling active`);
}
```

## Next Steps

1. **Add to timing-tests.mjs** (see TELEMETRY_INTEGRATION_EXAMPLES.md)
2. **Add to progressive-timing-benchmark.mjs**
3. **Add to test_N_*.mjs sweep tests** (minimal: one import + one line)
4. **Enable cold-start comparisons** — telemetry captures true starting state

## Troubleshooting

**All metrics show 'N/A':**
- LibreHardwareMonitor not installed (CPU clock/load will still work)
- WMI query permission denied (run as admin)

**Only some GPU/Power metrics missing:**
- Sensor not present on this hardware
- LibreHardwareMonitor doesn't expose this sensor

**CPU metrics working, GPU missing:**
- Normal — GPU sensors less commonly exposed via WMI
- Consider DirectX/GPU vendor API for game benches

## Architecture

```
hardware-telemetry.mjs
  ├─ collectHardwareTelemetry()
  │   ├─ CIM queries (CPU)
  │   └─ WMI queries (LibreHardwareMonitor)
  ├─ formatTelemetryReport()  (pretty-print)
  └─ toToonMetrics()          (TOON object)
```

Zero external dependencies. Graceful no-op on non-Windows.
