/**
 * Hardware Telemetry Utility for LibreHardwareMonitor
 * Collects CPU/GPU/System metrics via Windows WMI
 * Reusable across all benchmark tests
 */

import { execSync } from 'child_process';
import os from 'os';

export function collectHardwareTelemetry() {
  const telemetry = {
    platform: `${process.platform} (${process.arch})`,
    cpuModel: os.cpus()[0]?.model || 'Unknown',
    cores: os.cpus().length,
    memoryFreeGb: (os.freemem() / (1024 ** 3)).toFixed(1),
    memoryTotalGb: (os.totalmem() / (1024 ** 3)).toFixed(1),
    nodeHeapMb: (process.memoryUsage().heapUsed / (1024 ** 2)).toFixed(1),

    // CPU metrics
    cpuLoadPct: 'N/A',
    cpuClockCurrentGhz: 'N/A',
    cpuClockMaxGhz: 'N/A',
    cpuThrottlingPct: '100.0',
    cpuThrottlingState: 'Optimal',
    cpuVoltageMv: 'N/A',
    cpuPowerW: 'N/A',

    // Thermal
    cpuTemperatureCelsius: 'N/A',
    gpuTemperatureCelsius: 'N/A',
    storageTemperatureCelsius: 'N/A',

    // GPU metrics
    gpuClockMhz: 'N/A',
    gpuMemoryMhz: 'N/A',
    gpuMemoryUsedMb: 'N/A',
    gpuMemoryTotalMb: 'N/A',
    gpuLoadPct: 'N/A',
    gpuPowerW: 'N/A',

    // System power
    systemPowerW: 'N/A',

    // Fans
    cpuFanRpm: 'N/A',
    cpuFanDutyPct: 'N/A',
    caseAirflowRpm: 'N/A',
  };

  if (process.platform !== 'win32') {
    return telemetry;
  }

  // Get CPU info via CIM
  try {
    const psCommand = 'powershell.exe -NoProfile -Command "Get-CimInstance -ClassName Win32_Processor | Select-Object CurrentClockSpeed, MaxClockSpeed, LoadPercentage | ConvertTo-Json"';
    const output = execSync(psCommand, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
    const cpuData = JSON.parse(output);
    const data = Array.isArray(cpuData) ? cpuData[0] : cpuData;

    if (data && data.MaxClockSpeed) {
      const currentSpeedGhz = (data.CurrentClockSpeed / 1000).toFixed(2);
      const maxSpeedGhz = (data.MaxClockSpeed / 1000).toFixed(2);
      const throttleRatio = data.CurrentClockSpeed / data.MaxClockSpeed;

      telemetry.cpuLoadPct = data.LoadPercentage;
      telemetry.cpuClockCurrentGhz = currentSpeedGhz;
      telemetry.cpuClockMaxGhz = maxSpeedGhz;
      telemetry.cpuThrottlingPct = (throttleRatio * 100).toFixed(1);
      telemetry.cpuThrottlingState = throttleRatio < 0.95 ? 'Throttled' : 'Optimal';
    }
  } catch (_) {
    // CIM query failed
  }

  // Get LibreHardwareMonitor sensor data via WMI
  try {
    const hwCommand = 'powershell.exe -NoProfile -Command "Get-WmiObject -Namespace \'root\\LibreHardwareMonitor\' -Class Sensor 2>$null | Where-Object {$_.SensorType -match \'Temperature|Voltage|Load|Power|Clock|Fan\'} | Select-Object Name, Value, Parent, SensorType | ConvertTo-Json"';
    const hwOutput = execSync(hwCommand, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();

    if (hwOutput) {
      try {
        const sensors = JSON.parse(hwOutput);
        const sensorArray = Array.isArray(sensors) ? sensors : [sensors];

        for (const sensor of sensorArray) {
          if (!sensor || !sensor.Name || sensor.Value === null) continue;

          const name = sensor.Name.toLowerCase();
          const parent = (sensor.Parent || '').toLowerCase();
          const type = (sensor.SensorType || '').toLowerCase();
          const value = parseFloat(sensor.Value);

          // Temperature sensors
          if (type.includes('temperature')) {
            if (!telemetry.cpuTemperatureCelsius || telemetry.cpuTemperatureCelsius === 'N/A') {
              if (name.includes('package') || name.includes('die') || parent.includes('cpu')) {
                telemetry.cpuTemperatureCelsius = value.toFixed(1);
              }
            }
            if (!telemetry.gpuTemperatureCelsius || telemetry.gpuTemperatureCelsius === 'N/A') {
              if (parent.includes('gpu') || parent.includes('nvidia') || parent.includes('amd') || parent.includes('intel graphics')) {
                telemetry.gpuTemperatureCelsius = value.toFixed(1);
              }
            }
            if (!telemetry.storageTemperatureCelsius || telemetry.storageTemperatureCelsius === 'N/A') {
              if (parent.includes('drive') || parent.includes('disk') || parent.includes('ssd') || parent.includes('hdd')) {
                telemetry.storageTemperatureCelsius = value.toFixed(1);
              }
            }
          }

          // Voltage sensors (CPU core voltage)
          if (type.includes('voltage') && parent.includes('cpu') && !telemetry.cpuVoltageMv.includes('N/A')) {
            if (name.includes('vdd') || name.includes('core') || name.includes('cpu')) {
              telemetry.cpuVoltageMv = (value * 1000).toFixed(0);
            }
          }

          // Power sensors
          if (type.includes('power')) {
            if (parent.includes('cpu') && (telemetry.cpuPowerW === 'N/A' || !telemetry.cpuPowerW)) {
              telemetry.cpuPowerW = value.toFixed(1);
            }
            if (parent.includes('gpu') && (telemetry.gpuPowerW === 'N/A' || !telemetry.gpuPowerW)) {
              telemetry.gpuPowerW = value.toFixed(1);
            }
            if ((parent.includes('system') || name.includes('total')) && (telemetry.systemPowerW === 'N/A' || !telemetry.systemPowerW)) {
              telemetry.systemPowerW = value.toFixed(1);
            }
          }

          // Clock/Frequency sensors
          if (type.includes('clock') || type.includes('frequency')) {
            if (parent.includes('gpu')) {
              if (name.includes('core') && (telemetry.gpuClockMhz === 'N/A' || !telemetry.gpuClockMhz)) {
                telemetry.gpuClockMhz = Math.round(value).toString();
              }
              if (name.includes('memory') && (telemetry.gpuMemoryMhz === 'N/A' || !telemetry.gpuMemoryMhz)) {
                telemetry.gpuMemoryMhz = Math.round(value).toString();
              }
            }
          }

          // Load sensors
          if (type.includes('load')) {
            if (parent.includes('gpu') && (telemetry.gpuLoadPct === 'N/A' || !telemetry.gpuLoadPct)) {
              telemetry.gpuLoadPct = value.toFixed(1);
            }
          }

          // Fan sensors
          if (type.includes('fan')) {
            if (name.includes('cpu') && (telemetry.cpuFanRpm === 'N/A' || !telemetry.cpuFanRpm)) {
              telemetry.cpuFanRpm = Math.round(value).toString();
            }
            if ((name.includes('case') || name.includes('system')) && (telemetry.caseAirflowRpm === 'N/A' || !telemetry.caseAirflowRpm)) {
              telemetry.caseAirflowRpm = Math.round(value).toString();
            }
          }

          // Fan duty cycle
          if (type.includes('level') && name.includes('fan') && parent.includes('cpu')) {
            telemetry.cpuFanDutyPct = (value * 100).toFixed(1);
          }
        }

        // GPU memory (from dedicated sensors if available)
        if ((telemetry.gpuMemoryUsedMb === 'N/A' || !telemetry.gpuMemoryUsedMb) && sensorArray.length > 0) {
          for (const sensor of sensorArray) {
            if (!sensor) continue;
            const name = sensor.Name.toLowerCase();
            const parent = (sensor.Parent || '').toLowerCase();
            if (parent.includes('gpu') && name.includes('memory') && name.includes('used')) {
              telemetry.gpuMemoryUsedMb = Math.round(parseFloat(sensor.Value)).toString();
            }
            if (parent.includes('gpu') && name.includes('memory') && name.includes('total')) {
              telemetry.gpuMemoryTotalMb = Math.round(parseFloat(sensor.Value)).toString();
            }
          }
        }
      } catch (_) {
        // WMI parse error
      }
    }
  } catch (_) {
    // WMI query failed (LibreHardwareMonitor not installed)
  }

  return telemetry;
}

export function formatTelemetryReport(telemetry, compact = false) {
  if (compact) {
    return [
      `CPU: ${telemetry.cpuClockCurrentGhz}/${telemetry.cpuClockMaxGhz} GHz (${telemetry.cpuLoadPct}% load) ${telemetry.cpuTemperatureCelsius}°C`,
      telemetry.gpuClockMhz !== 'N/A' ? `GPU: ${telemetry.gpuClockMhz} MHz (${telemetry.gpuLoadPct}%) ${telemetry.gpuTemperatureCelsius}°C` : null,
      telemetry.cpuPowerW !== 'N/A' || telemetry.systemPowerW !== 'N/A' ? `Power: CPU=${telemetry.cpuPowerW}W Sys=${telemetry.systemPowerW}W` : null,
    ].filter(Boolean).join(' | ');
  }

  return [
    `🧠 Memory: ${telemetry.memoryFreeGb}GB free / ${telemetry.memoryTotalGb}GB total`,
    `📦 Node Heap: ${telemetry.nodeHeapMb}MB active`,
    `🔥 CPU: ${telemetry.cpuClockCurrentGhz}/${telemetry.cpuClockMaxGhz} GHz | Load: ${telemetry.cpuLoadPct}% | Throttle: ${telemetry.cpuThrottlingState}`,
    `🌡️ CPU Temp: ${telemetry.cpuTemperatureCelsius}°C | Fan: ${telemetry.cpuFanRpm} RPM (${telemetry.cpuFanDutyPct}%)`,
    `⚡ Power: CPU=${telemetry.cpuPowerW}W | GPU=${telemetry.gpuPowerW}W | System=${telemetry.systemPowerW}W`,
    telemetry.gpuClockMhz !== 'N/A' ? `🎮 GPU: Core=${telemetry.gpuClockMhz} MHz | Mem=${telemetry.gpuMemoryMhz} MHz | Load=${telemetry.gpuLoadPct}% | ${telemetry.gpuTemperatureCelsius}°C` : null,
    telemetry.gpuMemoryUsedMb !== 'N/A' ? `    VRAM: ${telemetry.gpuMemoryUsedMb}MB / ${telemetry.gpuMemoryTotalMb}MB` : null,
  ].filter(Boolean).join('\n');
}

export function toToonMetrics(telemetry) {
  return {
    CpuClockCurrentGhz: telemetry.cpuClockCurrentGhz,
    CpuClockMaxGhz: telemetry.cpuClockMaxGhz,
    CpuLoadPct: telemetry.cpuLoadPct,
    CpuThrottlingState: telemetry.cpuThrottlingState,
    CpuTemperatureCelsius: telemetry.cpuTemperatureCelsius,
    CpuVoltageMv: telemetry.cpuVoltageMv,
    CpuPowerW: telemetry.cpuPowerW,
    CpuFanRpm: telemetry.cpuFanRpm,
    CpuFanDutyPct: telemetry.cpuFanDutyPct,
    GpuClockMhz: telemetry.gpuClockMhz,
    GpuMemoryMhz: telemetry.gpuMemoryMhz,
    GpuMemoryUsedMb: telemetry.gpuMemoryUsedMb,
    GpuLoadPct: telemetry.gpuLoadPct,
    GpuTemperatureCelsius: telemetry.gpuTemperatureCelsius,
    GpuPowerW: telemetry.gpuPowerW,
    SystemPowerW: telemetry.systemPowerW,
    StorageTemperatureCelsius: telemetry.storageTemperatureCelsius,
  };
}
