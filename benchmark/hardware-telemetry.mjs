/**
 * Hardware Telemetry Utility via systeminformation
 * Collects CPU/GPU/System metrics on Windows/Linux/macOS
 * Reusable across all benchmark tests
 */

import si from 'systeminformation';
import os from 'os';

export async function collectHardwareTelemetry() {
  const telemetry = {
    platform: `${process.platform} (${process.arch})`,
    cpuModel: os.cpus()[0]?.model || 'Unknown',
    cores: os.cpus().length,
    memoryFreeGb: (os.freemem() / (1024 ** 3)).toFixed(1),
    memoryTotalGb: (os.totalmem() / (1024 ** 3)).toFixed(1),
    nodeHeapMb: (process.memoryUsage().heapUsed / (1024 ** 2)).toFixed(1),

    cpuLoadPct: 'N/A',
    cpuClockCurrentGhz: 'N/A',
    cpuClockMaxGhz: 'N/A',
    cpuThrottlingPct: '100.0',
    cpuThrottlingState: 'Optimal',
    cpuVoltageMv: 'N/A',
    cpuPowerW: 'N/A',
    cpuTemperatureCelsius: 'N/A',
    cpuFanRpm: 'N/A',
    cpuFanDutyPct: 'N/A',

    gpuClockMhz: 'N/A',
    gpuMemoryMhz: 'N/A',
    gpuMemoryUsedMb: 'N/A',
    gpuMemoryTotalMb: 'N/A',
    gpuLoadPct: 'N/A',
    gpuPowerW: 'N/A',
    gpuTemperatureCelsius: 'N/A',

    systemPowerW: 'N/A',
    storageTemperatureCelsius: 'N/A',
    caseAirflowRpm: 'N/A',
  };

  try {
    // CPU speed
    const cpu = await si.cpu();
    if (cpu.speedMin && cpu.speedMax) {
      telemetry.cpuClockCurrentGhz = (cpu.speed || cpu.speedMin).toFixed(2);
      telemetry.cpuClockMaxGhz = cpu.speedMax.toFixed(2);
    }

    // CPU load
    const load = await si.currentLoad();
    if (load.currentLoad >= 0) {
      telemetry.cpuLoadPct = load.currentLoad.toFixed(1);
    }

    // CPU temperature
    const temps = await si.cpuTemperature();
    if (temps.main) {
      telemetry.cpuTemperatureCelsius = temps.main.toFixed(1);
    }

    // Power profiles (CPU power if available)
    try {
      const powerData = await si.powerProfiles();
      if (powerData) {
        telemetry.cpuThrottlingState = powerData.active || 'Optimal';
      }
    } catch (_) {}

    // GPU info
    try {
      const graphics = await si.graphics();
      if (graphics.controllers && graphics.controllers.length > 0) {
        const gpu = graphics.controllers[0];
        if (gpu.temperatureGpu) {
          telemetry.gpuTemperatureCelsius = gpu.temperatureGpu.toFixed(1);
        }
        if (gpu.memoryUsed && gpu.memoryTotal) {
          telemetry.gpuMemoryUsedMb = gpu.memoryUsed;
          telemetry.gpuMemoryTotalMb = gpu.memoryTotal;
        }
      }
    } catch (_) {}

    // Cooling fans
    try {
      const fans = await si.fans();
      if (fans && fans.length > 0) {
        const cpuFan = fans.find(f => f.label?.toLowerCase().includes('cpu')) || fans[0];
        if (cpuFan) {
          telemetry.cpuFanRpm = Math.round(cpuFan.speed || 0).toString();
        }
      }
    } catch (_) {}

    // Storage temps
    try {
      const disks = await si.disksIO();
      if (disks && disks.length > 0) {
        const diskTemp = await si.diskLayout();
        if (diskTemp && diskTemp.length > 0 && diskTemp[0].temperature) {
          telemetry.storageTemperatureCelsius = diskTemp[0].temperature.toFixed(1);
        }
      }
    } catch (_) {}

  } catch (_) {
    // Graceful fallback if systeminformation fails
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
    `🔥 CPU: ${telemetry.cpuClockCurrentGhz}/${telemetry.cpuClockMaxGhz} GHz | Load: ${telemetry.cpuLoadPct}% | State: ${telemetry.cpuThrottlingState}`,
    `🌡️ CPU Temp: ${telemetry.cpuTemperatureCelsius}°C | Fan: ${telemetry.cpuFanRpm} RPM (${telemetry.cpuFanDutyPct}%)`,
    `⚡ Power: CPU=${telemetry.cpuPowerW}W | GPU=${telemetry.gpuPowerW}W | System=${telemetry.systemPowerW}W`,
    telemetry.gpuClockMhz !== 'N/A' ? `🎮 GPU: Core=${telemetry.gpuClockMhz} MHz | Mem=${telemetry.gpuMemoryMhz} MHz | Load=${telemetry.gpuLoadPct}% | ${telemetry.gpuTemperatureCelsius}°C` : null,
    telemetry.gpuMemoryUsedMb !== 'N/A' ? `    VRAM: ${telemetry.gpuMemoryUsedMb}MB / ${telemetry.gpuMemoryTotalMb}MB` : null,
  ].filter(Boolean).join('\n');
}

export function toToonMetrics(telemetry) {
  return {
    CpuLoadPct: telemetry.cpuLoadPct,
    CpuClockCurrentGhz: telemetry.cpuClockCurrentGhz,
    CpuClockMaxGhz: telemetry.cpuClockMaxGhz,
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

// Standalone execution
(async () => {
  const filename = new URL(import.meta.url).pathname;
  const argv1 = process.argv[1];
  const isMain = filename.endsWith('hardware-telemetry.mjs') || argv1.endsWith('hardware-telemetry.mjs');

  if (isMain) {
    const { writeFileSync, mkdirSync } = await import('fs');
    const { join } = await import('path');

    const telemetry = await collectHardwareTelemetry();

    // Console output
    console.log('\n' + formatTelemetryReport(telemetry));

    // TOON file output
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
    const outDir = join(process.cwd(), '..', 'docs', 'outputs', 'timing tests');
    try {
      mkdirSync(outDir, { recursive: true });
    } catch (_) {}

    const toonLines = [
      `TestName: hardware-telemetry`,
      `RunTimestamp: ${new Date().toISOString()}`,
      `Agent: hardware-telemetry-systeminformation`,
      `Platform: ${telemetry.platform}`,
      `CpuModel: ${telemetry.cpuModel}`,
      `Cores: ${telemetry.cores}`,
      '',
      '# Hardware Telemetry',
    ];

    const metrics = toToonMetrics(telemetry);
    Object.entries(metrics).forEach(([key, val]) => {
      toonLines.push(`${key}: ${val}`);
    });

    const outPath = join(outDir, `${timestamp}-hardware-telemetry.toon`);
    writeFileSync(outPath, toonLines.join('\n'));
    console.log(`\n✅ TOON written to: ${outPath}\n`);
  }
})();
