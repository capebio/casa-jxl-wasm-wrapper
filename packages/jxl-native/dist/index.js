import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
export class CapabilityMissing extends Error {
    code = "CapabilityMissing";
    cause;
    constructor(message, cause) {
        super(message);
        this.name = "CapabilityMissing";
        if (cause !== undefined) {
            this.cause = cause;
        }
    }
}
const require = createRequire(String(import.meta.url));
const packageRoot = dirname(fileURLToPath(String(import.meta.url)));
export function loadNativeBinding(options = {}) {
    const candidates = [
        options.prebuiltPath ?? resolvePrebuiltBinary(),
        options.sourcePath ?? resolveSourceBinary()
    ];
    let lastError;
    for (const candidate of candidates) {
        try {
            const binding = require(candidate);
            ensureBindingLoaded(binding, candidate);
            return binding;
        }
        catch (error) {
            lastError = error;
        }
    }
    throw new CapabilityMissing("jxl-native addon unavailable; falling back to WASM is required", lastError);
}
/** Expands jumbfBoxes into MetadataBoxSpec entries (type "jumb", compress true by default). */
function expandJumbfToCustomBoxes(options) {
    if (!options.jumbfBoxes?.length)
        return [];
    return options.jumbfBoxes.map(j => {
        const data = j.data instanceof ArrayBuffer ? new Uint8Array(j.data) : j.data;
        return { type: "jumb", data, compress: true };
    });
}
export function createNativeCodecFacade(binding) {
    if (typeof binding.createDecoder !== "function" || typeof binding.createEncoder !== "function") {
        throw new CapabilityMissing("jxl-native addon does not expose createDecoder/createEncoder");
    }
    ensureBindingLoaded(binding, "native binding");
    return {
        createDecoder(options) {
            const raw = binding.createDecoder(options);
            // Software fallback seek: same logic as WASM LibjxlDecoder.
            return {
                ...raw,
                async *seekToFrame(frameIndex) {
                    if (raw.seekToFrame) {
                        yield* raw.seekToFrame(frameIndex);
                        return;
                    }
                    for await (const ev of raw.events()) {
                        if (ev.type === "header" || ev.type === "error" || ev.type === "budget_exceeded") {
                            yield ev;
                        }
                        else if (ev.type === "progress" || ev.type === "final") {
                            if ((ev.frameIndex ?? 0) >= frameIndex)
                                yield ev;
                        }
                    }
                },
                async *seekToTime(timeMs) {
                    if (raw.seekToTime) {
                        yield* raw.seekToTime(timeMs);
                        return;
                    }
                    let targetFrame = -1;
                    for await (const ev of raw.events()) {
                        if (ev.type === "header" || ev.type === "error" || ev.type === "budget_exceeded") {
                            yield ev;
                        }
                        else if (ev.type === "progress" || ev.type === "final") {
                            if (targetFrame === -1) {
                                targetFrame = ev.animTicksPerSecond != null
                                    ? Math.floor(timeMs * ev.animTicksPerSecond / 1000)
                                    : 0;
                            }
                            if ((ev.frameIndex ?? 0) >= targetFrame)
                                yield ev;
                        }
                    }
                },
            };
        },
        createEncoder(options) {
            // Expand jumbfBoxes into customBoxes for parity with WASM facade.
            const jumbfExpanded = expandJumbfToCustomBoxes(options);
            // Convert new high-level fields into advancedFrameSettings for the native binding.
            const extraAdvanced = convertAdvancedControlsToPairs(options);
            const baseAdvanced = options.advancedFrameSettings ?? [];
            const mergedAdvanced = [...baseAdvanced, ...extraAdvanced];
            // Destructure to drop high-level sugar fields that the native binding does not yet understand
            // (or that we convert). This pattern is robust under exactOptionalPropertyTypes.
            const { jpegReconstruction, alreadyDownsampled, upsamplingMode, advancedControls, hdrMetadata, intensityTarget, premultiply, preferCICPForHDR, ...base } = options;
            const normalized = {
                ...base,
                customBoxes: [
                    ...(options.customBoxes ?? []),
                    ...jumbfExpanded,
                ],
                ...(mergedAdvanced.length > 0 ? { advancedFrameSettings: mergedAdvanced } : {}),
            };
            return binding.createEncoder(normalized);
        },
    };
}
/** Converts the new high-level advanced controls into raw advancedFrameSettings pairs. */
function convertAdvancedControlsToPairs(options) {
    const out = [];
    const ac = options.advancedControls;
    if (ac?.filters) {
        const f = ac.filters;
        if (f.dots !== undefined)
            out.push({ id: 7, value: f.dots ? 1 : 0 });
        if (f.patches !== undefined)
            out.push({ id: 8, value: f.patches ? 1 : 0 });
        if (f.epf !== undefined)
            out.push({ id: 9, value: f.epf });
        if (f.gaborish !== undefined)
            out.push({ id: 10, value: f.gaborish ? 1 : 0 });
    }
    if (ac?.groupOrder) {
        const g = ac.groupOrder;
        out.push({ id: 13, value: g.mode === 'center' ? 1 : 0 });
        if (g.centerX !== undefined)
            out.push({ id: 14, value: g.centerX });
        if (g.centerY !== undefined)
            out.push({ id: 15, value: g.centerY });
    }
    // Top-level progressiveDc (id 19) + groupOrder (id 13) for predator parity with WASM/jxl-core.
    // These are forwarded by jxl-worker-node encode-handler (and high-level session.encode) for Tauri/desktop paths.
    // The adv loop in native.cc will apply; explicit here ensures direct {progressiveDc:2} calls and non-advancedControls
    // usage work without caller having to use the escape hatch. Later entries in mergedAdvanced win on duplicates.
    if (options.progressiveDc != null) {
        const dc = Math.max(0, Math.min(2, (options.progressiveDc | 0)));
        out.push({ id: 19, value: dc });
    }
    if (options.groupOrder != null) {
        out.push({ id: 13, value: options.groupOrder ? 1 : 0 });
    }
    if (ac?.buffering) {
        const b = ac.buffering;
        if (b.strategy !== undefined)
            out.push({ id: 34, value: b.strategy });
        // lowMemoryMode / preferChunkedAPI can be handled via other means or ignored for now
    }
    // Simple scalars
    if (options.alreadyDownsampled !== undefined) {
        out.push({ id: 4, value: options.alreadyDownsampled ? 1 : 0 });
    }
    if (options.upsamplingMode !== undefined) {
        out.push({ id: 55, value: options.upsamplingMode }); // approximate ID; adjust if needed
    }
    // jpegReconstruction scalars (CFL etc.) can ride advanced pairs (ID 30 for CFL)
    if (options.jpegReconstruction?.cfl !== undefined) {
        out.push({ id: 30, value: options.jpegReconstruction.cfl ? 1 : 0 });
    }
    // Smart defaults (predator parity with WASM resolve): previewFirst promotes Dc>=1 + group=1 unless explicit.
    const hasProgDc = options.progressiveDc != null || out.some(p => p.id === 19);
    const hasGroup = options.groupOrder != null || out.some(p => p.id === 13);
    if (options.previewFirst) {
        if (!hasProgDc)
            out.push({ id: 19, value: 1 });
        if (!hasGroup)
            out.push({ id: 13, value: 1 });
    }
    return out;
}
export function createDecoder(options) {
    return createNativeCodecFacade(loadNativeBinding()).createDecoder(options);
}
export function createEncoder(options) {
    return createNativeCodecFacade(loadNativeBinding()).createEncoder(options);
}
function resolvePrebuiltBinary() {
    const platform = process?.platform ?? "unknown";
    const arch = process?.arch ?? "unknown";
    const base = join(packageRoot, "..", "prebuilds");
    const candidate = resolve(base, `${platform}-${arch}`, "jxl-native.node");
    return candidate;
}
function resolveSourceBinary() {
    const release = resolve(packageRoot, "..", "build", "Release", "jxl_native.node");
    const debug = resolve(packageRoot, "..", "build", "Debug", "jxl_native.node");
    return fileExists(release) ? release : fileExists(debug) ? debug : release;
}
function fileExists(path) {
    try {
        require("node:fs").accessSync(path);
        return true;
    }
    catch {
        return false;
    }
}
function ensureBindingLoaded(binding, label) {
    if (typeof binding.version === "function" && binding.version().includes("scaffold")) {
        throw new CapabilityMissing(`jxl-native addon at ${label} is still the scaffold stub`);
    }
    if (typeof binding.probe !== "function")
        return;
    const probe = binding.probe();
    if (typeof probe.path === "string" && probe.path.toLowerCase().includes("stub")) {
        throw new CapabilityMissing(`jxl-native addon at ${label} is still the scaffold stub`, probe);
    }
    if (probe.loaded !== true) {
        throw new CapabilityMissing(`jxl-native addon at ${label} is present but not loaded`, probe);
    }
}
//# sourceMappingURL=index.js.map