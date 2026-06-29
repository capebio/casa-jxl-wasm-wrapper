const base = new URL('./dist/', import.meta.url);
for (const tier of ['dec.simd','dec.simd-mt','dec.relaxed-simd-mt']) {
  try {
    const imported = await import(new URL(`./dist/jxl-core.${tier}.js`, import.meta.url).href);
    const factory = imported.default;
    const m = await factory({ locateFile: (p) => new URL(p, base).href });
    console.log(`LOADED ${tier}: decode_rgba8=${typeof m._jxl_wasm_decode_rgba8} dec_create=${typeof m._jxl_wasm_dec_create} set_region=${typeof m._jxl_wasm_dec_set_region}`);
  } catch (e) { console.log(`${tier} FAIL: ${String(e.message).slice(0,120)}`); }
}
