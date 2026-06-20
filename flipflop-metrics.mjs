// flipflop-metrics.mjs — per-flip memory + background system sampler (Windows PowerShell)
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';

export function memSnapshot() {
  const m = process.memoryUsage();
  return { rss_mb: +(m.rss / 1048576).toFixed(1), heap_mb: +(m.heapUsed / 1048576).toFixed(1) };
}

export function memDelta(before, after) {
  if (before === null || after === null) return { delta_rss_mb: 'n/a', delta_heap_mb: 'n/a' };
  return {
    delta_rss_mb: +(after.rss_mb - before.rss_mb).toFixed(1),
    delta_heap_mb: +(after.heap_mb - before.heap_mb).toFixed(1),
  };
}

export function nearestSample(samples, tMs) {
  if (!samples.length) return { cpu: 'n/a', freq: 'n/a', temp: 'n/a' };
  let best = samples[0], bestD = Math.abs(samples[0].t - tMs);
  for (const s of samples) {
    const d = Math.abs(s.t - tMs);
    if (d < bestD) { best = s; bestD = d; }
  }
  return { cpu: best.cpu, freq: best.freq, temp: best.temp };
}

const FREQ_THROTTLE = 0.90;
const TEMP_THROTTLE_C = 85;

export function throttleVerdict(samples) {
  const temps = samples.map((s) => s.temp).filter((t) => typeof t === 'number');
  const freqs = samples.map((s) => s.freq).filter((f) => typeof f === 'number');
  if (!samples.length || (!temps.length && !freqs.length)) {
    return { temp_c_start: 'n/a', temp_c_end: 'n/a', temp_c_max: 'n/a', freq_ratio_min: 'n/a', throttled: 'unknown', variance_flag: false };
  }
  const freqMin = freqs.length ? Math.min(...freqs) : 'n/a';
  const tempMax = temps.length ? Math.max(...temps) : 'n/a';
  const freqVaries = new Set(freqs).size > 1;   // a never-changing ratio (static CurrentClockSpeed) carries no throttle info
  let throttled;
  if (typeof tempMax === 'number') {
    throttled = tempMax >= TEMP_THROTTLE_C || (freqVaries && freqMin < FREQ_THROTTLE);
  } else if (freqVaries) {
    throttled = freqMin < FREQ_THROTTLE;
  } else {
    throttled = 'unknown';                      // no temp + static/absent freq → cannot tell honestly
  }
  return {
    temp_c_start: temps.length ? temps[0] : 'n/a',
    temp_c_end: temps.length ? temps[temps.length - 1] : 'n/a',
    temp_c_max: tempMax,
    freq_ratio_min: freqMin,
    throttled,
    variance_flag: false,        // set by engine from timing stdev
  };
}

// Emits one CSV line "cpu,freq,temp" per interval. Node timestamps each line on arrival.
// Instant CIM reads (no Get-Counter) so samples land fast enough to tag individual flips
// and short runs still capture state. CurrentClockSpeed reflects throttle on most laptops.
function samplerScript(intervalMs) {
  return `
$ErrorActionPreference='SilentlyContinue'
while ($true) {
  $p = Get-CimInstance Win32_Processor
  $cpu = $p.LoadPercentage
  if ($null -eq $cpu) { $cpu = 'n/a' }
  if ($p.MaxClockSpeed -and $p.CurrentClockSpeed) { $freq = [math]::Round($p.CurrentClockSpeed/$p.MaxClockSpeed,3) } else { $freq = 'n/a' }
  $temp = 'n/a'
  $lhm = Get-CimInstance -Namespace root/LibreHardwareMonitor -Class Sensor -EA SilentlyContinue | Where-Object { $_.SensorType -eq 'Temperature' -and $_.Identifier -match 'cpu' } | Measure-Object -Property Value -Maximum
  if ($lhm.Maximum) { $temp = [math]::Round($lhm.Maximum,1) } else {
    $ohm = Get-CimInstance -Namespace root/OpenHardwareMonitor -Class Sensor -EA SilentlyContinue | Where-Object { $_.SensorType -eq 'Temperature' -and $_.Identifier -match 'cpu' } | Measure-Object -Property Value -Maximum
    if ($ohm.Maximum) { $temp = [math]::Round($ohm.Maximum,1) } else {
      $z = Get-CimInstance -Namespace root/WMI -Class MSAcpi_ThermalZoneTemperature -EA SilentlyContinue | Select-Object -First 1 -ExpandProperty CurrentTemperature
      if ($z) { $temp = [math]::Round($z/10-273.15,1) }
    }
  }
  Write-Output ("{0},{1},{2}" -f $cpu, $freq, $temp)
  Start-Sleep -Milliseconds ${intervalMs}
}`;
}

export function startSampler({ intervalMs = 500 } = {}) {
  const t0 = performance.now();
  const samples = [];
  const handle = { samples, ok: false, stop() {} };
  let child;
  try {
    child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', samplerScript(intervalMs)],
      { windowsHide: true });
  } catch {
    return handle;            // degrade: ok stays false, samples empty
  }
  handle.ok = true;
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d.toString();
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line) continue;
      const [cpu, freq, temp] = line.split(',');
      samples.push({
        t: performance.now() - t0,
        cpu: cpu === 'n/a' ? 'n/a' : +cpu,
        freq: freq === 'n/a' ? 'n/a' : +freq,
        temp: temp === 'n/a' ? 'n/a' : +temp,
      });
    }
  });
  child.on('error', () => { handle.ok = false; });
  handle.stop = () => { try { child.kill(); } catch {} };
  return handle;
}
