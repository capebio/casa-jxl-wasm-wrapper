// pkg/raw_converter_wasm.js
class ProcessResult {
  static __wrap(ptr) {
    const obj = Object.create(ProcessResult.prototype);
    obj.__wbg_ptr = ptr;
    ProcessResultFinalization.register(obj, obj.__wbg_ptr, obj);
    return obj;
  }
  __destroy_into_raw() {
    const ptr = this.__wbg_ptr;
    this.__wbg_ptr = 0;
    ProcessResultFinalization.unregister(this);
    return ptr;
  }
  free() {
    const ptr = this.__destroy_into_raw();
    wasm.__wbg_processresult_free(ptr, 0);
  }
  get color_matrix_from_mn() {
    const ret = wasm.__wbg_get_processresult_color_matrix_from_mn(this.__wbg_ptr);
    return ret !== 0;
  }
  get decompress_ms() {
    const ret = wasm.__wbg_get_processresult_decompress_ms(this.__wbg_ptr);
    return ret;
  }
  get demosaic_ms() {
    const ret = wasm.__wbg_get_processresult_demosaic_ms(this.__wbg_ptr);
    return ret;
  }
  get exposure_den() {
    const ret = wasm.__wbg_get_processresult_exposure_den(this.__wbg_ptr);
    return ret >>> 0;
  }
  get exposure_num() {
    const ret = wasm.__wbg_get_processresult_exposure_num(this.__wbg_ptr);
    return ret >>> 0;
  }
  get fnumber_den() {
    const ret = wasm.__wbg_get_processresult_fnumber_den(this.__wbg_ptr);
    return ret >>> 0;
  }
  get fnumber_num() {
    const ret = wasm.__wbg_get_processresult_fnumber_num(this.__wbg_ptr);
    return ret >>> 0;
  }
  get focal_length_35() {
    const ret = wasm.__wbg_get_processresult_focal_length_35(this.__wbg_ptr);
    return ret;
  }
  get focal_length_den() {
    const ret = wasm.__wbg_get_processresult_focal_length_den(this.__wbg_ptr);
    return ret >>> 0;
  }
  get focal_length_num() {
    const ret = wasm.__wbg_get_processresult_focal_length_num(this.__wbg_ptr);
    return ret >>> 0;
  }
  get gps_alt() {
    const ret = wasm.__wbg_get_processresult_gps_alt(this.__wbg_ptr);
    return ret;
  }
  get gps_lat() {
    const ret = wasm.__wbg_get_processresult_gps_lat(this.__wbg_ptr);
    return ret;
  }
  get gps_lon() {
    const ret = wasm.__wbg_get_processresult_gps_lon(this.__wbg_ptr);
    return ret;
  }
  get has_gps() {
    const ret = wasm.__wbg_get_processresult_has_gps(this.__wbg_ptr);
    return ret !== 0;
  }
  get height() {
    const ret = wasm.__wbg_get_processresult_height(this.__wbg_ptr);
    return ret >>> 0;
  }
  get iso() {
    const ret = wasm.__wbg_get_processresult_iso(this.__wbg_ptr);
    return ret >>> 0;
  }
  get lb_h() {
    const ret = wasm.__wbg_get_processresult_lb_h(this.__wbg_ptr);
    return ret >>> 0;
  }
  get lb_w() {
    const ret = wasm.__wbg_get_processresult_lb_w(this.__wbg_ptr);
    return ret >>> 0;
  }
  get orient_ms() {
    const ret = wasm.__wbg_get_processresult_orient_ms(this.__wbg_ptr);
    return ret;
  }
  get orientation() {
    const ret = wasm.__wbg_get_processresult_orientation(this.__wbg_ptr);
    return ret;
  }
  get quality() {
    const ret = wasm.__wbg_get_processresult_quality(this.__wbg_ptr);
    return ret;
  }
  get thumb_h() {
    const ret = wasm.__wbg_get_processresult_thumb_h(this.__wbg_ptr);
    return ret >>> 0;
  }
  get thumb_w() {
    const ret = wasm.__wbg_get_processresult_thumb_w(this.__wbg_ptr);
    return ret >>> 0;
  }
  get tonemap_ms() {
    const ret = wasm.__wbg_get_processresult_tonemap_ms(this.__wbg_ptr);
    return ret;
  }
  get wb_b_used() {
    const ret = wasm.__wbg_get_processresult_wb_b_used(this.__wbg_ptr);
    return ret;
  }
  get wb_from_camera() {
    const ret = wasm.__wbg_get_processresult_wb_from_camera(this.__wbg_ptr);
    return ret !== 0;
  }
  get wb_mode() {
    const ret = wasm.__wbg_get_processresult_wb_mode(this.__wbg_ptr);
    return ret;
  }
  get wb_r_used() {
    const ret = wasm.__wbg_get_processresult_wb_r_used(this.__wbg_ptr);
    return ret;
  }
  get width() {
    const ret = wasm.__wbg_get_processresult_width(this.__wbg_ptr);
    return ret >>> 0;
  }
  color_matrix_used() {
    const ret = wasm.processresult_color_matrix_used(this.__wbg_ptr);
    var v1 = getArrayF32FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v1;
  }
  get datetime() {
    let deferred1_0;
    let deferred1_1;
    try {
      const ret = wasm.processresult_datetime(this.__wbg_ptr);
      deferred1_0 = ret[0];
      deferred1_1 = ret[1];
      return getStringFromWasm0(ret[0], ret[1]);
    } finally {
      wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
  }
  get lens() {
    let deferred1_0;
    let deferred1_1;
    try {
      const ret = wasm.processresult_lens(this.__wbg_ptr);
      deferred1_0 = ret[0];
      deferred1_1 = ret[1];
      return getStringFromWasm0(ret[0], ret[1]);
    } finally {
      wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
  }
  get make() {
    let deferred1_0;
    let deferred1_1;
    try {
      const ret = wasm.processresult_make(this.__wbg_ptr);
      deferred1_0 = ret[0];
      deferred1_1 = ret[1];
      return getStringFromWasm0(ret[0], ret[1]);
    } finally {
      wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
  }
  get model() {
    let deferred1_0;
    let deferred1_1;
    try {
      const ret = wasm.processresult_model(this.__wbg_ptr);
      deferred1_0 = ret[0];
      deferred1_1 = ret[1];
      return getStringFromWasm0(ret[0], ret[1]);
    } finally {
      wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
  }
  rgb() {
    const ret = wasm.processresult_rgb(this.__wbg_ptr);
    var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v1;
  }
  take_rgb() {
    const ret = wasm.processresult_take_rgb(this.__wbg_ptr);
    var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v1;
  }
  take_rgb16_lb() {
    const ret = wasm.processresult_take_rgb16_lb(this.__wbg_ptr);
    var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v1;
  }
  take_rgb16_thumb() {
    const ret = wasm.processresult_take_rgb16_thumb(this.__wbg_ptr);
    var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v1;
  }
}
if (Symbol.dispose)
  ProcessResult.prototype[Symbol.dispose] = ProcessResult.prototype.free;

class RotateResult {
  static __wrap(ptr) {
    const obj = Object.create(RotateResult.prototype);
    obj.__wbg_ptr = ptr;
    RotateResultFinalization.register(obj, obj.__wbg_ptr, obj);
    return obj;
  }
  __destroy_into_raw() {
    const ptr = this.__wbg_ptr;
    this.__wbg_ptr = 0;
    RotateResultFinalization.unregister(this);
    return ptr;
  }
  free() {
    const ptr = this.__destroy_into_raw();
    wasm.__wbg_rotateresult_free(ptr, 0);
  }
  get height() {
    const ret = wasm.__wbg_get_rotateresult_height(this.__wbg_ptr);
    return ret >>> 0;
  }
  get width() {
    const ret = wasm.__wbg_get_rotateresult_width(this.__wbg_ptr);
    return ret >>> 0;
  }
  take_rgb() {
    const ret = wasm.rotateresult_take_rgb(this.__wbg_ptr);
    var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v1;
  }
}
if (Symbol.dispose)
  RotateResult.prototype[Symbol.dispose] = RotateResult.prototype.free;
function process_orf(data, exposure_ev, contrast, highlights, shadows, whites, blacks, saturation, vibrance, temp, tint, wb_r_override, wb_b_override, texture, clarity) {
  const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
  const len0 = WASM_VECTOR_LEN;
  const ret = wasm.process_orf(ptr0, len0, exposure_ev, contrast, highlights, shadows, whites, blacks, saturation, vibrance, temp, tint, wb_r_override, wb_b_override, texture, clarity);
  if (ret[2]) {
    throw takeFromExternrefTable0(ret[1]);
  }
  return ProcessResult.__wrap(ret[0]);
}
function rgb_to_rgba(rgb) {
  const ptr0 = passArray8ToWasm0(rgb, wasm.__wbindgen_malloc);
  const len0 = WASM_VECTOR_LEN;
  const ret = wasm.rgb_to_rgba(ptr0, len0);
  var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
  wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
  return v2;
}
function __wbg_get_imports() {
  const import0 = {
    __proto__: null,
    __wbg_Error_bce6d499ff0a4aff: function(arg0, arg1) {
      const ret = Error(getStringFromWasm0(arg0, arg1));
      return ret;
    },
    __wbg___wbindgen_is_undefined_35bb9f4c7fd651d5: function(arg0) {
      const ret = arg0 === undefined;
      return ret;
    },
    __wbg___wbindgen_throw_9c31b086c2b26051: function(arg0, arg1) {
      throw new Error(getStringFromWasm0(arg0, arg1));
    },
    __wbg_instanceof_Window_faa5cf994f49cca7: function(arg0) {
      let result;
      try {
        result = arg0 instanceof Window;
      } catch (_) {
        result = false;
      }
      const ret = result;
      return ret;
    },
    __wbg_instanceof_WorkerGlobalScope_a93ee1765e6a23bf: function(arg0) {
      let result;
      try {
        result = arg0 instanceof WorkerGlobalScope;
      } catch (_) {
        result = false;
      }
      const ret = result;
      return ret;
    },
    __wbg_now_3cd905700d21a70b: function(arg0) {
      const ret = arg0.now();
      return ret;
    },
    __wbg_performance_a22a4e2bf3e69855: function(arg0) {
      const ret = arg0.performance;
      return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
    },
    __wbg_performance_ddd4e7eeef6254f3: function(arg0) {
      const ret = arg0.performance;
      return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
    },
    __wbg_static_accessor_GLOBAL_THIS_02344c9b09eb08a9: function() {
      const ret = typeof globalThis === "undefined" ? null : globalThis;
      return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
    },
    __wbg_static_accessor_GLOBAL_ac6d4ac874d5cd54: function() {
      const ret = typeof global === "undefined" ? null : global;
      return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
    },
    __wbg_static_accessor_SELF_9b2406c23aeb2023: function() {
      const ret = typeof self === "undefined" ? null : self;
      return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
    },
    __wbg_static_accessor_WINDOW_b34d2126934e16ba: function() {
      const ret = typeof window === "undefined" ? null : window;
      return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
    },
    __wbindgen_init_externref_table: function() {
      const table = wasm.__wbindgen_externrefs;
      const offset = table.grow(4);
      table.set(0, undefined);
      table.set(offset + 0, undefined);
      table.set(offset + 1, null);
      table.set(offset + 2, true);
      table.set(offset + 3, false);
    }
  };
  return {
    __proto__: null,
    "./raw_converter_wasm_bg.js": import0
  };
}
var ProcessResultFinalization = typeof FinalizationRegistry === "undefined" ? { register: () => {}, unregister: () => {} } : new FinalizationRegistry((ptr) => wasm.__wbg_processresult_free(ptr, 1));
var RotateResultFinalization = typeof FinalizationRegistry === "undefined" ? { register: () => {}, unregister: () => {} } : new FinalizationRegistry((ptr) => wasm.__wbg_rotateresult_free(ptr, 1));
function addToExternrefTable0(obj) {
  const idx = wasm.__externref_table_alloc();
  wasm.__wbindgen_externrefs.set(idx, obj);
  return idx;
}
function getArrayF32FromWasm0(ptr, len) {
  ptr = ptr >>> 0;
  return getFloat32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}
function getArrayU8FromWasm0(ptr, len) {
  ptr = ptr >>> 0;
  return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}
var cachedFloat32ArrayMemory0 = null;
function getFloat32ArrayMemory0() {
  if (cachedFloat32ArrayMemory0 === null || cachedFloat32ArrayMemory0.byteLength === 0) {
    cachedFloat32ArrayMemory0 = new Float32Array(wasm.memory.buffer);
  }
  return cachedFloat32ArrayMemory0;
}
function getStringFromWasm0(ptr, len) {
  return decodeText(ptr >>> 0, len);
}
var cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
  if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
    cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
  }
  return cachedUint8ArrayMemory0;
}
function isLikeNone(x) {
  return x === undefined || x === null;
}
function passArray8ToWasm0(arg, malloc) {
  const ptr = malloc(arg.length * 1, 1) >>> 0;
  getUint8ArrayMemory0().set(arg, ptr / 1);
  WASM_VECTOR_LEN = arg.length;
  return ptr;
}
function takeFromExternrefTable0(idx) {
  const value = wasm.__wbindgen_externrefs.get(idx);
  wasm.__externref_table_dealloc(idx);
  return value;
}
var cachedTextDecoder = new TextDecoder("utf-8", { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
var MAX_SAFARI_DECODE_BYTES = 2146435072;
var numBytesDecoded = 0;
function decodeText(ptr, len) {
  numBytesDecoded += len;
  if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
    cachedTextDecoder = new TextDecoder("utf-8", { ignoreBOM: true, fatal: true });
    cachedTextDecoder.decode();
    numBytesDecoded = len;
  }
  return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}
var WASM_VECTOR_LEN = 0;
var wasmModule;
var wasmInstance;
var wasm;
function __wbg_finalize_init(instance, module) {
  wasmInstance = instance;
  wasm = instance.exports;
  wasmModule = module;
  cachedFloat32ArrayMemory0 = null;
  cachedUint8ArrayMemory0 = null;
  wasm.__wbindgen_start();
  return wasm;
}
async function __wbg_load(module, imports) {
  if (typeof Response === "function" && module instanceof Response) {
    if (typeof WebAssembly.instantiateStreaming === "function") {
      try {
        return await WebAssembly.instantiateStreaming(module, imports);
      } catch (e) {
        const validResponse = module.ok && expectedResponseType(module.type);
        if (validResponse && module.headers.get("Content-Type") !== "application/wasm") {
          console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);
        } else {
          throw e;
        }
      }
    }
    const bytes = await module.arrayBuffer();
    return await WebAssembly.instantiate(bytes, imports);
  } else {
    const instance = await WebAssembly.instantiate(module, imports);
    if (instance instanceof WebAssembly.Instance) {
      return { instance, module };
    } else {
      return instance;
    }
  }
  function expectedResponseType(type) {
    switch (type) {
      case "basic":
      case "cors":
      case "default":
        return true;
    }
    return false;
  }
}
async function __wbg_init(module_or_path) {
  if (wasm !== undefined)
    return wasm;
  if (module_or_path !== undefined) {
    if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
      ({ module_or_path } = module_or_path);
    } else {
      console.warn("using deprecated parameters for the initialization function; pass a single object instead");
    }
  }
  if (module_or_path === undefined) {
    module_or_path = new URL("raw_converter_wasm_bg.wasm", import.meta.url);
  }
  const imports = __wbg_get_imports();
  if (typeof module_or_path === "string" || typeof Request === "function" && module_or_path instanceof Request || typeof URL === "function" && module_or_path instanceof URL) {
    module_or_path = fetch(module_or_path);
  }
  const { instance, module } = await __wbg_load(await module_or_path, imports);
  return __wbg_finalize_init(instance, module);
}

// web/jxl-wrapper-lab.js
import { createDecoder, createEncoder } from "@casabio/jxl-wasm";

// web/jxl-browser-context.js
import { createBrowserContext } from "@casabio/jxl-session";
var _ctx = null;
function getContext() {
  if (_ctx === null) {
    try {
      _ctx = createBrowserContext();
    } catch (err) {
      console.error("[jxl-browser-context] Failed to create JxlContext:", err);
      _ctx = {
        decode() {
          throw new Error("[jxl-browser-context] Context unavailable");
        },
        encode() {
          throw new Error("[jxl-browser-context] Context unavailable");
        },
        capabilities() {
          return {};
        },
        async shutdown() {}
      };
    }
  }
  return _ctx;
}

// web/jxl-dashboard-ui.js
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
function wireSlideoutPanel({
  panel,
  openButton,
  closeButton,
  defaultOpen = false
} = {}) {
  if (!panel)
    return { setOpen() {}, isOpen: () => false };
  const setOpen = (open) => {
    const next = Boolean(open);
    panel.dataset.open = next ? "true" : "false";
    panel.setAttribute("aria-hidden", next ? "false" : "true");
    if (openButton)
      openButton.setAttribute("aria-expanded", next ? "true" : "false");
  };
  openButton?.addEventListener("click", () => {
    setOpen(panel.dataset.open !== "true");
  });
  closeButton?.addEventListener("click", () => setOpen(false));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape")
      setOpen(false);
  });
  setOpen(defaultOpen);
  return {
    setOpen,
    isOpen: () => panel.dataset.open === "true"
  };
}
function wireHelpPopovers(root = document) {
  const buttons = [...root.querySelectorAll("[data-help-target]")];
  const popovers = [...root.querySelectorAll("[data-help-popover]")];
  const closeAll = () => {
    for (const popover of popovers)
      popover.hidden = true;
  };
  const toggle = (targetId) => {
    const popover = root.querySelector(`[data-help-popover="${CSS.escape(targetId)}"]`);
    if (!popover)
      return;
    const shouldOpen = popover.hidden;
    closeAll();
    popover.hidden = !shouldOpen ? true : false;
  };
  for (const button of buttons) {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      toggle(button.dataset.helpTarget);
    });
  }
  for (const popover of popovers) {
    popover.addEventListener("click", (event) => event.stopPropagation());
  }
  document.addEventListener("click", closeAll);
  return { closeAll, toggle };
}
function setGroupDisabled(group, disabled, reason = "") {
  if (!group)
    return;
  group.classList.toggle("is-disabled", Boolean(disabled));
  group.setAttribute("aria-disabled", Boolean(disabled) ? "true" : "false");
  if (reason)
    group.dataset.reason = reason;
  const controls = [...group.querySelectorAll("button, input, select, textarea")];
  for (const control of controls) {
    if (control.classList.contains("info-btn") || control.classList.contains("dashboard-toggle") || control.classList.contains("dashboard-close")) {
      continue;
    }
    control.disabled = Boolean(disabled);
  }
}
function bindRangeLabel(input, label, format = (value) => String(value)) {
  if (!input || !label)
    return () => {};
  const sync = () => {
    label.textContent = format(input.value);
  };
  input.addEventListener("input", sync);
  sync();
  return sync;
}
function setCssVar(name, value, root = document.documentElement) {
  root.style.setProperty(name, String(value));
}

// web/jxl-wrapper-lab.js
var MAX_BATCH_LIMIT = 100;
var RANDOM_LOAD_CONCURRENCY = 4;
var STATUS_UPDATE_INTERVAL_MS = 120;
var TILE_CANVAS_MAX_EDGE = 256;
var modeButtons = [...document.querySelectorAll("[data-mode]")];
var sourceInput = document.getElementById("source-input");
var sourceDrop = document.getElementById("source-drop");
var loadRandomBtn = document.getElementById("load-random");
var runBatchBtn = document.getElementById("run-batch");
var clearBatchBtn = document.getElementById("clear-batch");
var batchLimitInput = document.getElementById("batch-limit");
var batchConcurrencyInput = document.getElementById("batch-concurrency");
var batchQualityInput = document.getElementById("batch-quality");
var batchEffortInput = document.getElementById("batch-effort");
var batchLosslessInput = document.getElementById("batch-lossless");
var batchLimitValue = document.getElementById("batch-limit-value");
var batchConcurrencyValue = document.getElementById("batch-concurrency-value");
var batchQualityValue = document.getElementById("batch-quality-value");
var batchEffortValue = document.getElementById("batch-effort-value");
var batchThumbSizeInput = document.getElementById("batch-thumb-size");
var batchThumbSizeValue = document.getElementById("batch-thumb-size-value");
var wrapperDashboard = document.getElementById("wrapper-dashboard");
var wrapperControlsBtn = document.getElementById("wrapper-controls-btn");
var wrapperControlsClose = document.getElementById("wrapper-controls-close");
var selectionStatus = document.getElementById("selection-status");
var modeStatus = document.getElementById("mode-status");
var batchStatus = document.getElementById("batch-status");
var timingStatus = document.getElementById("timing-status");
var loadedCount = document.getElementById("loaded-count");
var queuedCount = document.getElementById("queued-count");
var doneCount = document.getElementById("done-count");
var errorCount = document.getElementById("error-count");
var batchGrid = document.getElementById("batch-grid");
var controlBand = document.querySelector(".control-band");
var statusGrid = document.querySelector(".status-grid");
var metricsStrip = document.querySelector(".metrics-strip");
var existingContext = getContext();
var paintScratchCanvas = document.createElement("canvas");
var currentMode = "existing";
var selectedSources = [];
var activeRunId = 0;
var batchThumbSize = Number(batchThumbSizeInput?.value) || 220;
var lastProgressStatusAt = 0;
function setMode(mode) {
  currentMode = mode;
  document.body.dataset.mode = mode;
  for (const button of modeButtons) {
    const active = button.dataset.mode === mode;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  }
  modeStatus.textContent = mode === "existing" ? "Existing session." : mode === "wrapper" ? "Wrapper libjxl." : "Compare mode.";
}
function syncSettingLabels() {
  batchLimitValue.textContent = String(getBatchLimit());
  batchConcurrencyValue.textContent = String(getConcurrency());
  batchQualityValue.textContent = String(getQuality());
  batchEffortValue.textContent = String(getEffort());
  loadRandomBtn.textContent = `Load ${getBatchLimit()} random Gobabeb file${getBatchLimit() === 1 ? "" : "s"}`;
}
function getBatchLimit() {
  return clamp(Number(batchLimitInput.value) || MAX_BATCH_LIMIT, 1, MAX_BATCH_LIMIT);
}
function getConcurrency() {
  return clamp(Number(batchConcurrencyInput.value) || 1, 1, 16);
}
function getQuality() {
  return clamp(Number(batchQualityInput.value) || 90, 50, 100);
}
function getEffort() {
  return clamp(Number(batchEffortInput.value) || 3, 1, 9);
}
function getLossless() {
  return Boolean(batchLosslessInput.checked);
}
function fmtBytes(n) {
  if (!Number.isFinite(n) || n <= 0)
    return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}
function fmtMs(ms) {
  if (!Number.isFinite(ms))
    return "--";
  return `${ms.toFixed(0)} ms`;
}
function fmtTiming(ms) {
  return ms == null ? "--" : `${ms.toFixed(0)} ms`;
}
function summarizeTiming(rows, key) {
  if (!rows.length)
    return null;
  const values = rows.map((row) => row[key]).filter((value) => Number.isFinite(value));
  if (!values.length)
    return null;
  const sum = values.reduce((total, value) => total + value, 0);
  return sum / values.length;
}
function timingsForCurrentMode(entries) {
  return entries.flatMap((entry) => {
    if (currentMode === "existing")
      return entry.existing ? [entry.existing] : [];
    if (currentMode === "wrapper")
      return entry.wrapper ? [entry.wrapper] : [];
    return [entry.existing, entry.wrapper].filter(Boolean);
  });
}
function formatRunSummary(entries) {
  const rows = timingsForCurrentMode(entries);
  if (!rows.length)
    return "no timing data";
  return [
    `load avg ${fmtTiming(summarizeTiming(rows, "loadMs"))}`,
    `enc avg ${fmtTiming(summarizeTiming(rows, "encodeMs"))}`,
    `first piece avg ${fmtTiming(summarizeTiming(rows, "firstPieceMs"))}`,
    `dec avg ${fmtTiming(summarizeTiming(rows, "decodeMs"))}`,
    `first paint avg ${fmtTiming(summarizeTiming(rows, "firstPaintMs"))}`
  ].join(" · ");
}
function toU8(value) {
  if (value instanceof Uint8Array)
    return value;
  return new Uint8Array(value);
}
function exactBuffer(view) {
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
}
function transferableBuffer(view) {
  if (view.byteOffset === 0 && view.byteLength === view.buffer.byteLength)
    return view.buffer;
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
}
function resultByteLength(result) {
  return result.byteLength ?? result.bytes?.byteLength ?? 0;
}
function concatChunks(chunks) {
  const views = chunks.map(toU8);
  const total = views.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of views) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
function sizeForMaxEdge(width, height, maxEdge = TILE_CANVAS_MAX_EDGE) {
  const largest = Math.max(width, height);
  if (!Number.isFinite(largest) || largest <= 0)
    return { width: 1, height: 1 };
  if (largest <= maxEdge)
    return { width, height };
  const scale = maxEdge / largest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale))
  };
}
function rgbaToCanvas(canvas, rgba, width, height) {
  if (canvas.width !== width)
    canvas.width = width;
  if (canvas.height !== height)
    canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength), width, height), 0, 0);
}
function paintDecodedToTileCanvas(canvas, decoded) {
  const width = decoded.info.width;
  const height = decoded.info.height;
  const target = sizeForMaxEdge(width, height);
  rgbaToCanvas(paintScratchCanvas, toU8(decoded.pixels), width, height);
  if (canvas.width !== target.width)
    canvas.width = target.width;
  if (canvas.height !== target.height)
    canvas.height = target.height;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "medium";
  ctx.clearRect(0, 0, target.width, target.height);
  ctx.drawImage(paintScratchCanvas, 0, 0, width, height, 0, 0, target.width, target.height);
}
function makeTile(index) {
  const tile = document.createElement("article");
  tile.className = "tile";
  tile.dataset.state = "idle";
  tile.innerHTML = `
        <header>
            <div>
                <p class="slot">Tile ${String(index + 1).padStart(2, "0")}</p>
                <h3>Waiting for source</h3>
            </div>
            <div class="chip" data-kind="compare">Idle</div>
        </header>
        <canvas width="96" height="96"></canvas>
        <div class="tile-meta">
            <div class="metric-line" data-kind="existing"><span>Existing</span><strong>--</strong></div>
            <div class="metric-line" data-kind="wrapper"><span>Wrapper</span><strong>--</strong></div>
            <div class="metric-line" data-kind="timing"><span>Timing</span><strong>--</strong></div>
            <div class="metric-line" data-kind="compare"><span>Compare</span><strong>--</strong></div>
        </div>
    `;
  return {
    el: tile,
    title: tile.querySelector("h3"),
    chip: tile.querySelector(".chip"),
    canvas: tile.querySelector("canvas"),
    existing: tile.querySelector('.metric-line[data-kind="existing"] strong'),
    wrapper: tile.querySelector('.metric-line[data-kind="wrapper"] strong'),
    timing: tile.querySelector('.metric-line[data-kind="timing"] strong'),
    compare: tile.querySelector('.metric-line[data-kind="compare"] strong')
  };
}
var tiles = Array.from({ length: MAX_BATCH_LIMIT }, (_, index) => makeTile(index));
for (const tile of tiles)
  batchGrid.appendChild(tile.el);
function resetTile(tile, label = "Waiting for source") {
  tile.el.dataset.state = "idle";
  tile.title.textContent = label;
  tile.chip.textContent = "Idle";
  tile.existing.textContent = "--";
  tile.wrapper.textContent = "--";
  tile.timing.textContent = "--";
  tile.compare.textContent = "--";
  tile._timings = null;
  const ctx = tile.canvas.getContext("2d");
  tile.canvas.width = 96;
  tile.canvas.height = 96;
  ctx.clearRect(0, 0, tile.canvas.width, tile.canvas.height);
}
function resetGrid() {
  for (const tile of tiles)
    resetTile(tile);
}
function setCounters({ loaded = selectedSources.length, queued = 0, done = 0, errors = 0 } = {}) {
  loadedCount.textContent = String(loaded);
  queuedCount.textContent = String(queued);
  doneCount.textContent = String(done);
  errorCount.textContent = String(errors);
}
function setStatus(text, timing = "Ready.") {
  batchStatus.textContent = text;
  timingStatus.textContent = timing;
}
function updateProgressStatus({ started, jobs, done, errors, force = false }) {
  const now = performance.now();
  if (!force && now - lastProgressStatusAt < STATUS_UPDATE_INTERVAL_MS)
    return;
  lastProgressStatusAt = now;
  setCounters({ loaded: selectedSources.length, queued: jobs.length, done, errors });
  timingStatus.textContent = `${fmtMs(now - started)} elapsed`;
}
function syncBatchThumbSize() {
  if (batchThumbSizeInput) {
    batchThumbSize = clamp(Number(batchThumbSizeInput.value) || 220, 120, 320);
    batchThumbSizeInput.value = String(batchThumbSize);
    if (batchThumbSizeValue)
      batchThumbSizeValue.textContent = String(batchThumbSize);
    setCssVar("--batch-thumb-size", `${batchThumbSize}px`);
  }
}
async function loadRandomFileSource() {
  const started = performance.now();
  const resp = await fetch("/api/random-gobabeb", { cache: "no-store" });
  if (!resp.ok)
    throw new Error(`random Gobabeb request failed: ${resp.status}`);
  const raw = new Uint8Array(await resp.arrayBuffer());
  const name = resp.headers.get("x-file-name") || "random.orf";
  const folder = resp.headers.get("x-source-folder") || "source folder";
  const source = await loadBytesSourceByName(raw, name, folder, resp.headers.get("x-file-size") || "");
  source.loadMs = performance.now() - started;
  return source;
}
async function loadFileSource(file) {
  const started = performance.now();
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  if (ext === "orf") {
    const raw = new Uint8Array(await file.arrayBuffer());
    const source = loadBytesAsSource(raw, file.name, "", `${fmtBytes(file.size)}`);
    source.loadMs = performance.now() - started;
    return source;
  }
  if (ext === "jxl") {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const source = await decodeBytesToSource(bytes, `${file.name} Â· JXL Â· ${fmtBytes(file.size)}`);
    source.loadMs = performance.now() - started;
    return source;
  }
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  bitmap.close?.();
  return {
    name: file.name,
    label: `${file.name} Â· ${canvas.width}Ã—${canvas.height}`,
    meta: fmtBytes(file.size),
    width: canvas.width,
    height: canvas.height,
    rgba: new Uint8Array(pixels.buffer.slice(0)),
    loadMs: performance.now() - started
  };
}
async function loadBytesSourceByName(bytes, name, folder = "", sizeLabel = "") {
  const started = performance.now();
  const ext = (name.split(".").pop() || "").toLowerCase();
  if (ext === "orf") {
    const source = loadBytesAsSource(bytes, name, folder, sizeLabel);
    source.loadMs = performance.now() - started;
    return source;
  }
  if (ext === "jxl") {
    const source = await decodeBytesToSource(bytes, `${name} Â· JXL Â· ${sizeLabel || fmtBytes(bytes.byteLength)}`);
    source.loadMs = performance.now() - started;
    return source;
  }
  if (["jpg", "jpeg", "png", "tif", "tiff", "bmp", "gif", "webp"].includes(ext)) {
    const blob = new Blob([bytes], { type: `image/${ext === "jpg" ? "jpeg" : ext}` });
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0);
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    bitmap.close?.();
    return {
      name,
      label: `${name} Â· ${canvas.width}Ã—${canvas.height}`,
      meta: [folder, sizeLabel || fmtBytes(bytes.byteLength)].filter(Boolean).join(" Â· "),
      width: canvas.width,
      height: canvas.height,
      rgba: new Uint8Array(pixels.buffer.slice(0)),
      loadMs: performance.now() - started
    };
  }
  return {
    name,
    label: `${name} Â· ${fmtBytes(bytes.byteLength)}`,
    meta: [folder, "unsupported"].filter(Boolean).join(" Â· "),
    width: 1,
    height: 1,
    rgba: new Uint8Array([255, 0, 255, 255]),
    loadMs: performance.now() - started
  };
}
function loadBytesAsSource(bytes, name, folder = "", sizeLabel = "") {
  const started = performance.now();
  const result = process_orf(bytes, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, NaN, NaN, 0, 0);
  try {
    const rgb = result.take_rgb();
    return {
      name,
      label: `${name} Â· ORF Â· ${result.width}Ã—${result.height}`,
      meta: [folder, sizeLabel].filter(Boolean).join(" Â· "),
      width: result.width,
      height: result.height,
      rgba: rgb_to_rgba(rgb),
      loadMs: performance.now() - started
    };
  } finally {
    result.free();
  }
}
async function decodeBytesToSource(bytes, label) {
  const started = performance.now();
  const decoder = createDecoder({
    format: "rgba8",
    region: null,
    downsample: 1,
    progressionTarget: "final",
    emitEveryPass: false,
    preserveIcc: true,
    preserveMetadata: true
  });
  await decoder.push(bytes);
  await decoder.close();
  let final = null;
  for await (const ev of decoder.events()) {
    if (ev.type === "final")
      final = ev;
  }
  if (!final)
    throw new Error("JXL decode produced no final frame");
  return {
    name: label,
    label: `${label} Â· JXL Â· ${final.info.width}Ã—${final.info.height}`,
    meta: "decoded by wrapper",
    width: final.info.width,
    height: final.info.height,
    rgba: toU8(final.pixels),
    loadMs: performance.now() - started
  };
}
function buildBatchSources() {
  const limit = getBatchLimit();
  if (!selectedSources.length)
    return [];
  const out = [];
  for (let i = 0;i < limit; i++) {
    out.push(selectedSources[i % selectedSources.length]);
  }
  return out;
}
async function loadSourcesFromFiles(fileList) {
  const files = [...fileList].slice(0, MAX_BATCH_LIMIT);
  if (!files.length)
    return;
  const started = performance.now();
  batchStatus.textContent = `Loading ${files.length} file(s)...`;
  const loaded = [];
  for (const file of files) {
    loaded.push(await loadFileSource(file));
  }
  selectedSources = loaded;
  const elapsed = performance.now() - started;
  selectionStatus.textContent = `${loaded.length} file(s) ready in ${fmtTiming(elapsed)}.`;
  batchStatus.textContent = `Loaded ${loaded.length} file(s) in ${fmtTiming(elapsed)}.`;
  setCounters({ loaded: loaded.length });
}
async function loadRandomSources(count = MAX_BATCH_LIMIT) {
  const total = clamp(count, 1, MAX_BATCH_LIMIT);
  const started = performance.now();
  batchStatus.textContent = `Loading Gobabeb files 0/${total}...`;
  const loaded = Array(total);
  let nextIndex = 0;
  let completed = 0;
  const workers = Array.from({ length: Math.min(RANDOM_LOAD_CONCURRENCY, total) }, async () => {
    while (nextIndex < total) {
      const index = nextIndex++;
      loaded[index] = await loadRandomFileSource();
      completed++;
      batchStatus.textContent = `Loading Gobabeb files ${completed}/${total}...`;
      selectionStatus.textContent = `Loaded ${completed}/${total} random Gobabeb files.`;
      setCounters({ loaded: completed });
    }
  });
  await Promise.all(workers);
  selectedSources = loaded;
  const elapsed = performance.now() - started;
  selectionStatus.textContent = `${loaded.length} random Gobabeb files ready in ${fmtTiming(elapsed)}.`;
  batchStatus.textContent = `Loaded ${loaded.length}/${total} random Gobabeb files in ${fmtTiming(elapsed)}.`;
  setCounters({ loaded: loaded.length });
}
function makeEncoderOptions(source) {
  const lossless = getLossless();
  return {
    format: "rgba8",
    width: source.width,
    height: source.height,
    hasAlpha: true,
    iccProfile: null,
    exif: null,
    xmp: null,
    distance: lossless ? 0 : null,
    quality: lossless ? null : getQuality(),
    effort: getEffort(),
    progressive: false,
    previewFirst: false,
    chunked: false
  };
}
function makeDecoderOptions() {
  return {
    format: "rgba8",
    region: null,
    downsample: 1,
    progressionTarget: "final",
    emitEveryPass: false,
    preserveIcc: true,
    preserveMetadata: true
  };
}
async function encodeWithWrapper(source) {
  const started = performance.now();
  const encoder = createEncoder(makeEncoderOptions(source));
  const chunks = [];
  let firstChunkMs = null;
  const chunkTask = (async () => {
    for await (const chunk of encoder.chunks()) {
      if (firstChunkMs == null)
        firstChunkMs = performance.now() - started;
      chunks.push(chunk);
    }
  })();
  await encoder.pushPixels(source.rgba);
  await encoder.finish();
  await chunkTask;
  return { bytes: concatChunks(chunks), encodeMs: performance.now() - started, firstChunkMs };
}
async function decodeWithWrapper(bytes) {
  const decoder = createDecoder(makeDecoderOptions());
  await decoder.push(bytes);
  await decoder.close();
  let final = null;
  for await (const ev of decoder.events()) {
    if (ev.type === "final")
      final = ev;
  }
  if (!final)
    throw new Error("wrapper decode produced no final frame");
  return { final };
}
async function encodeWithSession(source) {
  const started = performance.now();
  const session = existingContext.encode(makeEncoderOptions(source));
  const chunks = [];
  let firstChunkMs = null;
  const chunkTask = (async () => {
    for await (const chunk of session.chunks()) {
      if (firstChunkMs == null)
        firstChunkMs = performance.now() - started;
      chunks.push(chunk);
    }
  })();
  await session.pushPixels(exactBuffer(source.rgba));
  await session.finish();
  await chunkTask;
  return { bytes: concatChunks(chunks), encodeMs: performance.now() - started, firstChunkMs };
}
async function decodeWithSession(bytes) {
  const session = existingContext.decode(makeDecoderOptions());
  await session.push(transferableBuffer(bytes));
  await session.close();
  let final = null;
  for await (const ev of session.frames()) {
    if (ev.stage === "final")
      final = ev;
  }
  if (!final)
    throw new Error("existing session decode produced no final frame");
  return { final };
}
function paintTileResult(tile, source, existingResult, wrapperResult, startedAt) {
  const canvas = tile.canvas;
  const decoded = currentMode === "existing" ? existingResult.final : currentMode === "wrapper" ? wrapperResult.final : wrapperResult.final;
  const paintStarted = performance.now();
  paintDecodedToTileCanvas(canvas, decoded);
  const paintMs = performance.now() - paintStarted;
  const firstPaintMs = performance.now() - startedAt;
  tile.el.dataset.state = "done";
  tile.chip.textContent = currentMode === "compare" ? "Compare" : currentMode === "wrapper" ? "Wrapper" : "Existing";
  tile.title.textContent = source.label;
  tile.existing.textContent = existingResult ? `${fmtBytes(resultByteLength(existingResult))} Â· ${fmtMs(existingResult.encodeMs)} Â· ${fmtMs(existingResult.decodeMs)}` : "--";
  tile.wrapper.textContent = wrapperResult ? `${fmtBytes(resultByteLength(wrapperResult))} Â· ${fmtMs(wrapperResult.encodeMs)} Â· ${fmtMs(wrapperResult.decodeMs)}` : "--";
  tile.existing.textContent = existingResult ? `${fmtBytes(resultByteLength(existingResult))} Â· load ${fmtMs(existingResult.loadMs)} Â· enc ${fmtMs(existingResult.encodeMs)} Â· first ${fmtMs(existingResult.firstPieceMs)} Â· dec ${fmtMs(existingResult.decodeMs)}` : "--";
  tile.wrapper.textContent = wrapperResult ? `${fmtBytes(resultByteLength(wrapperResult))} Â· load ${fmtMs(wrapperResult.loadMs)} Â· enc ${fmtMs(wrapperResult.encodeMs)} Â· first ${fmtMs(wrapperResult.firstPieceMs)} Â· dec ${fmtMs(wrapperResult.decodeMs)}` : "--";
  tile.timing.textContent = `first paint ${fmtMs(firstPaintMs)} Â· draw ${fmtMs(paintMs)}`;
  if (existingResult && wrapperResult) {
    const byteDelta = resultByteLength(wrapperResult) - resultByteLength(existingResult);
    const msDelta = wrapperResult.totalMs - existingResult.totalMs;
    const paintDelta = (wrapperResult.firstPaintMs ?? wrapperResult.totalMs) - (existingResult.firstPaintMs ?? existingResult.totalMs);
    tile.compare.textContent = `${byteDelta === 0 ? "bytes match" : `${byteDelta > 0 ? "+" : ""}${byteDelta} B`} · total ${msDelta >= 0 ? "+" : ""}${msDelta.toFixed(0)} ms · paint ${paintDelta >= 0 ? "+" : ""}${paintDelta.toFixed(0)} ms`;
  } else {
    tile.compare.textContent = "--";
  }
  const ms = performance.now() - startedAt;
  if (currentMode === "compare") {
    tile.chip.textContent = "Compare";
  }
  tile.el.title = `${source.label} · first paint ${fmtTiming(firstPaintMs)} · total ${fmtTiming(ms)}`;
  return { paintMs, firstPaintMs, totalMs: ms };
}
async function processOneSource(source, index, runId) {
  const tile = tiles[index];
  if (!tile)
    return;
  tile.el.dataset.state = "working";
  tile.title.textContent = source.label;
  tile.chip.textContent = "Working";
  const startedAt = performance.now();
  let existingResult = null;
  let wrapperResult = null;
  try {
    if (currentMode === "existing" || currentMode === "compare") {
      const encodeStart = performance.now();
      const encoded = await encodeWithSession(source);
      const encodeMs = encoded.encodeMs ?? performance.now() - encodeStart;
      const byteLength = encoded.bytes.byteLength;
      const decodeStart = performance.now();
      const decoded = await decodeWithSession(encoded.bytes);
      const decodeMs = performance.now() - decodeStart;
      existingResult = {
        bytes: encoded.bytes,
        byteLength,
        encodeMs,
        firstPieceMs: encoded.firstChunkMs ?? null,
        decodeMs,
        totalMs: performance.now() - startedAt,
        loadMs: source.loadMs ?? null,
        firstPaintMs: null,
        final: decoded.final
      };
    }
    if (currentMode === "wrapper" || currentMode === "compare") {
      const encodeStart = performance.now();
      const encoded = await encodeWithWrapper(source);
      const encodeMs = encoded.encodeMs ?? performance.now() - encodeStart;
      const byteLength = encoded.bytes.byteLength;
      const decodeStart = performance.now();
      const decoded = await decodeWithWrapper(encoded.bytes);
      const decodeMs = performance.now() - decodeStart;
      wrapperResult = {
        bytes: encoded.bytes,
        byteLength,
        encodeMs,
        firstPieceMs: encoded.firstChunkMs ?? null,
        decodeMs,
        totalMs: performance.now() - startedAt,
        loadMs: source.loadMs ?? null,
        firstPaintMs: null,
        final: decoded.final
      };
    }
    if (runId !== activeRunId)
      return;
    const renderTiming = paintTileResult(tile, source, existingResult, wrapperResult, startedAt);
    if (existingResult && renderTiming) {
      existingResult.firstPaintMs = renderTiming.firstPaintMs;
      existingResult.paintMs = renderTiming.paintMs;
      existingResult.totalMs = renderTiming.totalMs;
    }
    if (wrapperResult && renderTiming) {
      wrapperResult.firstPaintMs = renderTiming.firstPaintMs;
      wrapperResult.paintMs = renderTiming.paintMs;
      wrapperResult.totalMs = renderTiming.totalMs;
    }
    tile._timings = {
      existing: existingResult,
      wrapper: wrapperResult,
      render: renderTiming
    };
    tile.el.dataset.state = "done";
    return true;
  } catch (error) {
    if (runId !== activeRunId)
      return;
    tile.el.dataset.state = "error";
    tile.chip.textContent = "Error";
    tile.compare.textContent = error?.message || String(error);
    return false;
  }
}
async function runBatch() {
  const runId = ++activeRunId;
  const sources = buildBatchSources();
  if (!sources.length) {
    setStatus("Load files or random ORFs first.");
    return;
  }
  const jobs = sources.slice(0, getBatchLimit());
  const concurrency = getConcurrency();
  let done = 0;
  let errors = 0;
  const started = performance.now();
  lastProgressStatusAt = 0;
  resetGrid();
  setCounters({ loaded: selectedSources.length, queued: jobs.length, done: 0, errors: 0 });
  setStatus(`Running ${jobs.length} tiles in ${currentMode} mode...`);
  const queue = jobs.map((source, index) => ({ source, index }));
  const workers = Array.from({ length: concurrency }, async () => {
    while (queue.length && runId === activeRunId) {
      const next = queue.shift();
      if (!next)
        break;
      try {
        const ok = await processOneSource(next.source, next.index, runId);
        if (ok)
          done++;
        else
          errors++;
      } catch {
        errors++;
      }
      updateProgressStatus({ started, jobs, done, errors });
    }
  });
  await Promise.all(workers);
  if (runId !== activeRunId)
    return;
  updateProgressStatus({ started, jobs, done, errors, force: true });
  const finishedTiles = tiles.slice(0, jobs.length).map((tile) => tile._timings).filter(Boolean);
  const summary = formatRunSummary(finishedTiles);
  setStatus(errors ? `Done with ${errors} error(s).` : "Done.", `${fmtMs(performance.now() - started)} elapsed · ${summary}`);
}
function clearBatch() {
  activeRunId++;
  selectedSources = [];
  sourceInput.value = "";
  selectionStatus.textContent = "No files loaded.";
  resetGrid();
  setCounters({ loaded: 0, queued: 0, done: 0, errors: 0 });
  setStatus("Idle.", "Ready.");
}
function wireControls() {
  syncSettingLabels();
  setMode("existing");
  setStatus("Idle.", "Ready.");
  resetGrid();
  for (const button of modeButtons) {
    button.addEventListener("click", () => {
      setMode(button.dataset.mode);
    });
  }
  sourceInput.addEventListener("change", async () => {
    if (!sourceInput.files?.length)
      return;
    await loadSourcesFromFiles(sourceInput.files);
    setCounters({ loaded: selectedSources.length });
  });
  sourceDrop.addEventListener("dragover", (event) => {
    event.preventDefault();
    sourceDrop.classList.add("is-drop-target");
  });
  sourceDrop.addEventListener("dragleave", () => {
    sourceDrop.classList.remove("is-drop-target");
  });
  sourceDrop.addEventListener("drop", async (event) => {
    event.preventDefault();
    sourceDrop.classList.remove("is-drop-target");
    if (!event.dataTransfer?.files?.length)
      return;
    await loadSourcesFromFiles(event.dataTransfer.files);
    setCounters({ loaded: selectedSources.length });
  });
  loadRandomBtn.addEventListener("click", async () => {
    await loadRandomSources(getBatchLimit());
    setCounters({ loaded: selectedSources.length });
  });
  runBatchBtn.addEventListener("click", () => {
    runBatch().catch((error) => {
      setStatus(`Failed: ${error?.message || error}`);
    });
  });
  clearBatchBtn.addEventListener("click", clearBatch);
  batchLimitInput.addEventListener("input", syncSettingLabels);
  batchConcurrencyInput.addEventListener("input", syncSettingLabels);
  batchQualityInput.addEventListener("input", syncSettingLabels);
  batchEffortInput.addEventListener("input", syncSettingLabels);
}
function wireDashboardControls() {
  wireSlideoutPanel({
    panel: wrapperDashboard,
    openButton: wrapperControlsBtn,
    closeButton: wrapperControlsClose
  });
  wireHelpPopovers(wrapperDashboard);
  wrapperDashboard?.appendChild(controlBand);
  wrapperDashboard?.appendChild(statusGrid);
  wrapperDashboard?.appendChild(metricsStrip);
  bindRangeLabel(batchThumbSizeInput, batchThumbSizeValue, (value) => String(value));
  batchThumbSizeInput?.addEventListener("input", syncBatchThumbSize);
  syncBatchThumbSize();
  setGroupDisabled(wrapperDashboard?.querySelector('[data-group="progressive"]'), true, "Progressive encode controls live on the progressive page.");
  setGroupDisabled(wrapperDashboard?.querySelector('[data-group="display"]'), false);
}
await __wbg_init();
wireDashboardControls();
wireControls();
setCounters({ loaded: 0, queued: 0, done: 0, errors: 0 });
