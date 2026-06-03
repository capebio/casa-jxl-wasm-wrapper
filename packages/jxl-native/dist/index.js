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
            const { jpegReconstruction, alreadyDownsampled, upsamplingMode, advancedControls, hdrMetadata, intensityTarget, preferCICPForHDR, frameIndexing, allowExpertOptions, disablePerceptualHeuristics, ...base } = options;
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
    if (options.centerX != null)
        out.push({ id: 14, value: Math.floor(options.centerX) });
    if (options.centerY != null)
        out.push({ id: 15, value: Math.floor(options.centerY) });
    if (ac?.buffering) {
        const b = ac.buffering;
        let strat = b.strategy;
        if (strat === undefined) {
            if (b.lowMemoryMode || b.streamingInput || b.streamingOutput)
                strat = 3;
        }
        if (strat !== undefined)
            out.push({ id: 34, value: strat });
    }
    // Simple scalars
    if (options.alreadyDownsampled !== undefined) {
        out.push({ id: 4, value: options.alreadyDownsampled ? 1 : 0 });
    }
    if (options.upsamplingMode !== undefined) {
        out.push({ id: 55, value: options.upsamplingMode }); // note: upsampling_mode is via JxlEncoderSetUpsamplingMode(enc, factor, mode), not pure frame ID; 55 placeholder for pairs compat
    }
    if (options.ecResampling !== undefined) {
        out.push({ id: 3, value: options.ecResampling });
    }
    // jpegReconstruction scalars (CFL etc.) can ride advanced pairs (ID 30 for CFL)
    if (options.jpegReconstruction?.cfl !== undefined) {
        out.push({ id: 30, value: options.jpegReconstruction.cfl ? 1 : 0 });
    }
    // Fine-grained JPEG strip (row 7): keep* emit as pairs (35/36/37); last-wins adv escape preserved.
    if (options.jpegReconstruction?.keepExif !== undefined) {
        out.push({ id: 35, value: options.jpegReconstruction.keepExif ? 1 : 0 });
    }
    if (options.jpegReconstruction?.keepXmp !== undefined) {
        out.push({ id: 36, value: options.jpegReconstruction.keepXmp ? 1 : 0 });
    }
    if (options.jpegReconstruction?.keepJumbf !== undefined) {
        out.push({ id: 37, value: options.jpegReconstruction.keepJumbf ? 1 : 0 });
    }
    // Row 12 full dec-hints: colorSpace / icc accepted in jpegReconstruction for API parity (raw color override or recon). No direct frame ID; handled at extras layer in reference. Pairs not emitted (higher-level than 35-37).
    // (colorSpace / icc on options.jpegReconstruction are dropped above and not converted to pairs; available for consumer if needed.)
    // Row 9/10/11 (cjxl audit): frameIndexing (31), allowExpert (effort gate), disablePerceptual (39). Emitted as pairs (last-wins with escape).
    if (options.frameIndexing) {
        // Note: full regex validation lives in WASM resolve (cjxl ProcessFlags); native trusts caller or escape.
        out.push({ id: 31, value: 1 }); // basic single-frame mark; per-frame future
    }
    if (options.allowExpertOptions !== undefined) {
        // The effort range gate (1-11 vs 1-10) is enforced in WASM resolve when flag set; native binding + libjxl accept 11 when passed.
        // We emit a no-op marker or rely on pairs for 11; here just ensure flag presence doesn't break.
    }
    if (options.disablePerceptualHeuristics !== undefined) {
        out.push({ id: 39, value: options.disablePerceptualHeuristics ? 1 : 0 });
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