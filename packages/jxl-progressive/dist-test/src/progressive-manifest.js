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
    assertField(typeof src["height"] === "number", "source.height", "source.height must be a number");
    assertField(typeof src["hasAlpha"] === "boolean", "source.hasAlpha", "source.hasAlpha must be a boolean");
    assertField(typeof src["orientation"] === "number", "source.orientation", "source.orientation must be a number");
    // jxl
    assertField(typeof obj["jxl"] === "object" && obj["jxl"] !== null, "jxl", "jxl must be an object");
    const jxl = obj["jxl"];
    assertField(typeof jxl["bytes"] === "number", "jxl.bytes", "jxl.bytes must be a number");
    assertField(typeof jxl["sha256"] === "string", "jxl.sha256", "jxl.sha256 must be a string");
    // encoder
    assertField(typeof obj["encoder"] === "object" && obj["encoder"] !== null, "encoder", "encoder must be an object");
    const enc = obj["encoder"];
    assertField(typeof enc["name"] === "string", "encoder.name", "encoder.name must be a string");
    assertField(typeof enc["libjxlVersion"] === "string", "encoder.libjxlVersion", "encoder.libjxlVersion must be a string");
    assertField(Array.isArray(enc["flags"]), "encoder.flags", "encoder.flags must be an array");
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
        assertField(typeof t["byteEnd"] === "number", `${f}.byteEnd`, `${f}.byteEnd must be a number`);
        assertField(typeof t["progressionIndex"] === "number" || t["progressionIndex"] === "final", `${f}.progressionIndex`, `${f}.progressionIndex must be number or "final"`);
        assertField(typeof t["intendedUse"] === "string", `${f}.intendedUse`, `${f}.intendedUse must be a string`);
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
        hashHex = Array.from(new Uint8Array(hashBuf))
            .map((b) => b.toString(16).padStart(2, "0"))
            .join("");
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