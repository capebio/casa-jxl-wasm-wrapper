// packages/jxl-progressive/src/progressive-manifest.ts
export class ManifestValidationError extends Error {
    field;
    constructor(message, field) {
        super(message);
        this.field = field;
        this.name = "ManifestValidationError";
    }
}
export class ManifestStaleError extends Error {
    constructor(message) {
        super(message);
        this.name = "ManifestStaleError";
    }
}
function assertField(condition, field, message) {
    if (!condition)
        throw new ManifestValidationError(message, field);
}
const VALID_TIER_NAMES = new Set(["dc", "preview", "full"]);
export function validateManifest(json) {
    assertField(typeof json === "object" && json !== null, "root", "Manifest must be an object");
    const obj = json;
    assertField(obj["version"] === 1, "version", "Manifest version must be 1");
    // source
    assertField(typeof obj["source"] === "object" && obj["source"] !== null, "source", "source must be an object");
    const src = obj["source"];
    assertField(typeof src["width"] === "number", "source.width", "source.width must be a number");
    assertField(src["width"] > 0, "source.width", "source.width must be > 0");
    assertField(typeof src["height"] === "number", "source.height", "source.height must be a number");
    assertField(src["height"] > 0, "source.height", "source.height must be > 0");
    assertField(typeof src["hasAlpha"] === "boolean", "source.hasAlpha", "source.hasAlpha must be a boolean");
    assertField(typeof src["orientation"] === "number", "source.orientation", "source.orientation must be a number");
    // jxl
    assertField(typeof obj["jxl"] === "object" && obj["jxl"] !== null, "jxl", "jxl must be an object");
    const jxl = obj["jxl"];
    assertField(typeof jxl["bytes"] === "number", "jxl.bytes", "jxl.bytes must be a number");
    assertField(Number.isInteger(jxl["bytes"]) && jxl["bytes"] > 0, "jxl.bytes", "jxl.bytes must be a positive integer");
    assertField(typeof jxl["sha256"] === "string", "jxl.sha256", "jxl.sha256 must be a string");
    // encoder
    assertField(typeof obj["encoder"] === "object" && obj["encoder"] !== null, "encoder", "encoder must be an object");
    const enc = obj["encoder"];
    assertField(typeof enc["name"] === "string", "encoder.name", "encoder.name must be a string");
    assertField(enc["name"].length <= 256, "encoder.name", "encoder.name must be <= 256 chars");
    assertField(typeof enc["libjxlVersion"] === "string", "encoder.libjxlVersion", "encoder.libjxlVersion must be a string");
    assertField(enc["libjxlVersion"].length <= 64, "encoder.libjxlVersion", "encoder.libjxlVersion must be <= 64 chars");
    assertField(Array.isArray(enc["flags"]), "encoder.flags", "encoder.flags must be an array");
    assertField(enc["flags"].length <= 64, "encoder.flags", "encoder.flags must have <= 64 entries");
    for (let fi = 0; fi < enc["flags"].length; fi++) {
        assertField(typeof enc["flags"][fi] === "string", `encoder.flags[${fi}]`, `encoder.flags[${fi}] must be a string`);
    }
    // saliency (optional; tighten ranges when present so scheduler boosts are safe)
    if (obj["saliency"] !== undefined) {
        assertField(typeof obj["saliency"] === "object" && obj["saliency"] !== null, "saliency", "saliency must be an object if present");
        const s = obj["saliency"];
        assertField(typeof s["enabled"] === "boolean", "saliency.enabled", "saliency.enabled must be a boolean");
        assertField(typeof s["centerX"] === "number" && s["centerX"] >= 0 && s["centerX"] <= 1, "saliency.centerX", "saliency.centerX must be number in [0,1]");
        assertField(typeof s["centerY"] === "number" && s["centerY"] >= 0 && s["centerY"] <= 1, "saliency.centerY", "saliency.centerY must be number in [0,1]");
        assertField(typeof s["confidence"] === "number" && s["confidence"] >= 0 && s["confidence"] <= 1, "saliency.confidence", "saliency.confidence must be number in [0,1]");
        assertField(typeof s["method"] === "string", "saliency.method", "saliency.method must be a string");
    }
    // perceptual passthrough (optional, loose for future color science transport)
    if (obj["perceptual"] !== undefined) {
        assertField(typeof obj["perceptual"] === "object" && obj["perceptual"] !== null && !Array.isArray(obj["perceptual"]), "perceptual", "perceptual must be an object if present");
        assertField(Object.keys(obj["perceptual"]).length <= 32, "perceptual", "perceptual must have <= 32 keys");
    }
    // tiers
    assertField(Array.isArray(obj["tiers"]), "tiers", "tiers must be an array");
    const tiersArr = obj["tiers"];
    assertField(tiersArr.length > 0, "tiers", "tiers must not be empty");
    for (let i = 0; i < tiersArr.length; i++) {
        const t = tiersArr[i];
        const f = `tiers[${i}]`;
        assertField(typeof t === "object" && t !== null, f, `${f} must be an object`);
        assertField(VALID_TIER_NAMES.has(t["name"]), `${f}.name`, `${f}.name must be dc|preview|full`);
        assertField(typeof t["byteStart"] === "number", `${f}.byteStart`, `${f}.byteStart must be a number`);
        assertField(Number.isFinite(t["byteStart"]) && t["byteStart"] >= 0, `${f}.byteStart`, `${f}.byteStart must be a finite non-negative number`);
        assertField(typeof t["byteEnd"] === "number", `${f}.byteEnd`, `${f}.byteEnd must be a number`);
        assertField(Number.isFinite(t["byteEnd"]) && t["byteEnd"] > 0, `${f}.byteEnd`, `${f}.byteEnd must be a finite positive number`);
        assertField(t["byteEnd"] > t["byteStart"], `${f}.byteEnd`, `${f}.byteEnd must be greater than ${f}.byteStart`);
        assertField(t["byteEnd"] <= jxl["bytes"], `${f}.byteEnd`, `${f}.byteEnd (${t["byteEnd"]}) exceeds jxl.bytes (${jxl["bytes"]})`);
        assertField(typeof t["progressionIndex"] === "number" || t["progressionIndex"] === "final", `${f}.progressionIndex`, `${f}.progressionIndex must be number or "final"`);
        assertField(typeof t["intendedUse"] === "string", `${f}.intendedUse`, `${f}.intendedUse must be a string`);
    }
    // Cross-tier: each tier name must appear at most once.
    const seenNames = new Set();
    for (let i = 0; i < tiersArr.length; i++) {
        const name = tiersArr[i]["name"];
        assertField(!seenNames.has(name), `tiers[${i}].name`, `tier name "${name}" must appear at most once`);
        seenNames.add(name);
    }
    // Cross-tier: byteEnd must be strictly ascending across tiers (all tiers are cumulative
    // from byte 0; the consumer issues Range: bytes=0-{byteEnd-1} per tier).
    for (let i = 1; i < tiersArr.length; i++) {
        const prev = tiersArr[i - 1]["byteEnd"];
        const curr = tiersArr[i]["byteEnd"];
        assertField(curr > prev, `tiers[${i}].byteEnd`, `tiers[${i}].byteEnd (${curr}) must be greater than tiers[${i - 1}].byteEnd (${prev})`);
    }
    return json;
}
export function lookupTier(manifest, name) {
    return manifest.tiers.find((t) => t.name === name);
}
export async function checkHash(manifest, jxlBytes) {
    let hashHex;
    if (typeof globalThis.crypto !== "undefined" &&
        typeof globalThis.crypto.subtle?.digest === "function") {
        const hashBuf = await globalThis.crypto.subtle.digest("SHA-256", jxlBytes);
        const hashBytes = new Uint8Array(hashBuf);
        let hex = "";
        for (let i = 0; i < hashBytes.length; i++) {
            hex += hashBytes[i].toString(16).padStart(2, "0");
        }
        hashHex = hex;
    }
    else {
        // Node.js fallback (crypto.subtle not available or not cross-origin-isolated)
        const { createHash } = await import("node:crypto");
        hashHex = createHash("sha256")
            .update(Buffer.from(jxlBytes))
            .digest("hex");
    }
    return hashHex === manifest.jxl.sha256;
}
export function migrateManifest(json) {
    if (typeof json === "object" && json !== null) {
        const v = json["version"];
        if (typeof v === "number" && v > 1) {
            throw new ManifestValidationError(`Cannot migrate manifest version ${v} (only version 1 supported)`, "version");
        }
    }
    return validateManifest(json);
}
//# sourceMappingURL=progressive-manifest.js.map