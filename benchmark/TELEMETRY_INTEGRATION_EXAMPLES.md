# Telemetry Integration Examples

Quick copy-paste integrations for main benchmark tests.

## timing-tests.mjs

### Step 1: Add import at top
```javascript
import { collectHardwareTelemetry, toToonMetrics } from './hardware-telemetry.mjs';
```

### Step 2: Collect at main() start
```javascript
async function main() {
  const telemetry = collectHardwareTelemetry();
  // ... rest of main
}
```

### Step 3: Modify toonRunString call
```javascript
  const outPath = join(OUT_DIR, `${TIMESTAMP}-timing-tests.toon`);
  writeFileSync(outPath, toonRunString({
    timestamp: TIMESTAMP,
    test: 'timing-tests',
    agent: 'codex',
    tier,
    source: rawFiles.length && jpegFiles.length ? 'mixed' : rawFiles.length ? 'raw' : 'jpeg',
    raw_limit: rawFiles.length,
    jpeg_limit: jpegFiles.length,
    target: TARGET,
    quality: QUALITY,
    efforts: EFFORTS,
    modes: MODES,
    records,
    telemetry,  // <-- ADD THIS
  }), 'utf8');
```

### Step 4: Update toonRunString function
```javascript
function toonRunString(run) {
  const lines = [];
  const timeBase = run.records.length ? run.records[0].timestamp.slice(0, 14) : run.timestamp.slice(0, 14);
  lines.push(`TestName: ${run.test}`);
  lines.push(`RunTimestamp: ${run.timestamp}`);
  lines.push(`Agent: ${run.agent}`);
  lines.push(`Tier: ${run.tier}`);
  lines.push(`Source: ${run.source}`);
  lines.push(`RawLimit: ${run.raw_limit}`);
  lines.push(`JpegLimit: ${run.jpeg_limit}`);
  lines.push(`Target: ${run.target}`);
  lines.push(`Quality: ${run.quality}`);
  lines.push(`Efforts: ${run.efforts.join(', ')}`);
  lines.push(`Modes: ${run.modes.join(', ')}`);
  lines.push(`TimeBase: ${timeBase}`);
  lines.push('');
  
  // ADD TELEMETRY SECTION
  if (run.telemetry) {
    lines.push('# Hardware Telemetry');
    const metrics = toToonMetrics(run.telemetry);
    Object.entries(metrics).forEach(([key, val]) => {
      lines.push(`${key}: ${val}`);
    });
    lines.push('');
  }
  
  lines.push('---');
  // ... rest of function unchanged
}
```

## test_N_*.mjs sweep tests (e.g., test_14_modular_mode_sweep.mjs)

### Minimal integration (all sweep tests)
```javascript
import { collectHardwareTelemetry, formatTelemetryReport } from './hardware-telemetry.mjs';

async function main() {
  const telemetry = collectHardwareTelemetry();
  console.log('\nHardware: ' + formatTelemetryReport(telemetry, true));
  
  // ... benchmark loop ...
}
```

## progressive-timing-benchmark.mjs

### Step 1: Import
```javascript
import { collectHardwareTelemetry, toToonMetrics } from './hardware-telemetry.mjs';
```

### Step 2: Collect and embed
```javascript
async function main() {
  const telemetry = collectHardwareTelemetry();
  console.log(formatTelemetryReport(telemetry));
  
  // ... encode/decode loop ...
  
  // Add to final TOON output
  const toonLines = [ /* existing lines */ ];
  if (telemetry.cpuPowerW !== 'N/A') {
    toonLines.push('', '# Hardware Telemetry');
    const metrics = toToonMetrics(telemetry);
    Object.entries(metrics).forEach(([key, val]) => {
      toonLines.push(`${key}: ${val}`);
    });
  }
  
  writeFileSync(outPath, toonLines.join('\n'));
}
```

## benchmark/optimal-settings-timing-toon.test.mjs

```javascript
import { collectHardwareTelemetry } from './hardware-telemetry.mjs';

describe('optimal settings', async () => {
  const telemetry = collectHardwareTelemetry();
  
  beforeEach(() => {
    // log thermal state before each run
    if (parseFloat(telemetry.cpuTemperatureCelsius) > 85) {
      console.warn(`⚠️ High CPU temp: ${telemetry.cpuTemperatureCelsius}°C — results may be throttled`);
    }
  });
  
  it('should encode at expected speed', async () => {
    // ... test body ...
  });
});
```

## Pattern: Conditional high-temperature warnings

Use this pattern in any test that loops/benches for long durations:

```javascript
async function runBenchmarkLoop() {
  const telemetry = collectHardwareTelemetry();
  const startTemp = parseFloat(telemetry.cpuTemperatureCelsius) || 0;
  
  for (let i = 0; i < iterations; i++) {
    const midTemp = collectHardwareTelemetry();
    
    if (parseFloat(midTemp.cpuTemperatureCelsius) > 85) {
      console.warn(`⚠️ THERMAL DRIFT: iteration ${i}, CPU ${midTemp.cpuTemperatureCelsius}°C (started ${startTemp}°C)`);
    }
    
    // ... benchmark operation ...
  }
  
  const endTemp = collectHardwareTelemetry();
  console.log(`Thermal range: ${startTemp}°C → ${endTemp.cpuTemperatureCelsius}°C`);
}
```

## One-liner console output

```javascript
import { formatTelemetryReport, collectHardwareTelemetry } from './hardware-telemetry.mjs';

// Single line at start
console.log(`HW: ${formatTelemetryReport(collectHardwareTelemetry(), true)}`);
```

## Checking for throttling mid-test

```javascript
const telemetry = collectHardwareTelemetry();
if (telemetry.cpuThrottlingState.includes('Throttled')) {
  console.warn(`⚠️ CPU is throttled: ${telemetry.cpuThrottlingState}`);
  console.warn(`   Current: ${telemetry.cpuClockCurrentGhz}GHz, Max: ${telemetry.cpuClockMaxGhz}GHz`);
}
```
