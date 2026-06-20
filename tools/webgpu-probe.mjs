// WebGPU feasibility probe — launches Chromium with WebGPU enabled, reports the
// adapter identity (real iGPU vs software SwiftShader fallback) and runs a real
// compute shader end-to-end (dispatch + readback parity). Decides whether a WebGPU
// tone/demosaic path is worth pursuing on THIS machine.
//   node tools/webgpu-probe.mjs
import { chromium } from 'playwright';

const browser = await chromium.launch({
  headless: true,
  args: [
    '--enable-unsafe-webgpu',
    '--enable-features=Vulkan',
    '--ignore-gpu-blocklist',
    '--use-angle=default',
  ],
});
const page = await browser.newPage();
page.on('console', (m) => { if (m.type() === 'error') console.error('[page]', m.text()); });

const result = await page.evaluate(async () => {
  if (!navigator.gpu) return { ok: false, reason: 'navigator.gpu undefined (WebGPU not exposed)' };
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) return { ok: false, reason: 'requestAdapter() returned null' };
  let info = adapter.info || {};
  if (!info.vendor && adapter.requestAdapterInfo) { try { info = await adapter.requestAdapterInfo(); } catch {} }
  const lim = adapter.limits;
  const limits = {
    maxComputeInvocationsPerWorkgroup: lim.maxComputeInvocationsPerWorkgroup,
    maxComputeWorkgroupSizeX: lim.maxComputeWorkgroupSizeX,
    maxStorageBufferBindingSize: lim.maxStorageBufferBindingSize,
    maxBufferSize: lim.maxBufferSize,
  };

  // Real compute: out[i] = in[i]*2 + 1, over N floats. Proves end-to-end execution.
  let computeOK = false, sample = null, dispatchMs = null;
  try {
    const device = await adapter.requestDevice();
    const N = 1 << 20; // 1M floats
    const inp = new Float32Array(N);
    for (let i = 0; i < N; i++) inp[i] = i % 1000;
    const bytes = inp.byteLength;
    const inBuf = device.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(inBuf, 0, inp);
    const outBuf = device.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const readBuf = device.createBuffer({ size: bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const module = device.createShaderModule({ code: `
      @group(0) @binding(0) var<storage, read> inp: array<f32>;
      @group(0) @binding(1) var<storage, read_write> outp: array<f32>;
      @compute @workgroup_size(64)
      fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
        let i = gid.x;
        if (i < arrayLength(&inp)) { outp[i] = inp[i] * 2.0 + 1.0; }
      }` });
    const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });
    const bind = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: inBuf } },
      { binding: 1, resource: { buffer: outBuf } },
    ] });
    const t0 = performance.now();
    const enc = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(pipeline); pass.setBindGroup(0, bind);
    pass.dispatchWorkgroups(Math.ceil(N / 64));
    pass.end();
    enc.copyBufferToBuffer(outBuf, 0, readBuf, 0, bytes);
    device.queue.submit([enc.finish()]);
    await device.queue.onSubmittedWorkDone();
    dispatchMs = Math.round((performance.now() - t0) * 100) / 100;
    await readBuf.mapAsync(GPUMapMode.READ);
    const got = new Float32Array(readBuf.getMappedRange().slice(0));
    readBuf.unmap();
    sample = [got[0], got[1], got[500], got[999]]; // expect 1, 3, 1001, 1999
    computeOK = got[0] === 1 && got[1] === 3 && got[500] === 1001 && got[999] === 1999;
  } catch (e) {
    return { ok: true, adapter: info, limits, computeOK: false, computeError: String(e) };
  }
  return { ok: true, adapter: info, limits, computeOK, sample, dispatchMs };
});

console.log(JSON.stringify(result, null, 2));
// Verdict
if (result.ok && result.adapter) {
  const desc = `${result.adapter.vendor || ''} ${result.adapter.architecture || ''} ${result.adapter.device || ''} ${result.adapter.description || ''}`.toLowerCase();
  const software = /swiftshader|llvmpipe|software|warp|microsoft basic/.test(desc);
  console.log(`\nVERDICT: WebGPU ${result.ok ? 'AVAILABLE' : 'UNAVAILABLE'} | compute ${result.computeOK ? 'PASS' : 'FAIL'} | backend = ${software ? 'SOFTWARE fallback (no real GPU accel)' : 'HARDWARE (real GPU)'}`);
}
await browser.close();
