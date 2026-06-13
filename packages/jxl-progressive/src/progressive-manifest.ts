// packages/jxl-progressive/src/progressive-manifest.ts

export type TierName = "dc" | "preview" | "full";

export interface ManifestTier {
  name: TierName;
  byteStart: number;
  byteEnd: number;
  progressionIndex: number | "final";
  intendedUse: string;
}

export interface ProgressiveManifest {
  version: 1;
  source: {
    width: number;
    height: number;
    hasAlpha: boolean;
    orientation: number;
  };
  jxl: {
    bytes: number;
    sha256: string;
  };
  encoder: {
    name: string;
    libjxlVersion: string;
    flags: string[];
  };
  saliency?: {
    enabled: boolean;
    centerX: number; // normalised 0–1
    centerY: number; // normalised 0–1
    confidence: number;
    method: string;
  };
  /** Optional passthrough for future perceptual / non-Riemannian color engine params
   *  (e.g. from advanced LookRenderer / LUT / geodesic). Transported via manifest to
   *  onManifest consumers for illumination-invariant adjustments etc. No cost here.
   */
  perceptual?: Record<string, unknown>;
  tiers: ManifestTier[];
}

export class ManifestValidationError extends Error {
  constructor(
    message: string,
    public readonly field: string,
  ) {
    super(message);
    this.name = "ManifestValidationError";
  }
}

export class ManifestStaleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestStaleError";
  }
}

function assertField(
  condition: boolean,
  field: string,
  message: string,
): asserts condition {
  if (!condition) throw new ManifestValidationError(message, field);
}

const VALID_TIER_NAMES = new Set<string>(["dc", "preview", "full"]);

export function validateManifest(json: unknown): ProgressiveManifest {
  assertField(
    typeof json === "object" && json !== null,
    "root",
    "Manifest must be an object",
  );
  const obj = json as Record<string, unknown>;

  assertField(obj["version"] === 1, "version", "Manifest version must be 1");

  // source
  assertField(
    typeof obj["source"] === "object" && obj["source"] !== null,
    "source",
    "source must be an object",
  );
  const src = obj["source"] as Record<string, unknown>;
  assertField(typeof src["width"] === "number", "source.width", "source.width must be a number");
  assertField(typeof src["height"] === "number", "source.height", "source.height must be a number");
  assertField(typeof src["hasAlpha"] === "boolean", "source.hasAlpha", "source.hasAlpha must be a boolean");
  assertField(typeof src["orientation"] === "number", "source.orientation", "source.orientation must be a number");

  // jxl
  assertField(
    typeof obj["jxl"] === "object" && obj["jxl"] !== null,
    "jxl",
    "jxl must be an object",
  );
  const jxl = obj["jxl"] as Record<string, unknown>;
  assertField(typeof jxl["bytes"] === "number", "jxl.bytes", "jxl.bytes must be a number");
  assertField(typeof jxl["sha256"] === "string", "jxl.sha256", "jxl.sha256 must be a string");

  // encoder
  assertField(
    typeof obj["encoder"] === "object" && obj["encoder"] !== null,
    "encoder",
    "encoder must be an object",
  );
  const enc = obj["encoder"] as Record<string, unknown>;
  assertField(typeof enc["name"] === "string", "encoder.name", "encoder.name must be a string");
  assertField(typeof enc["libjxlVersion"] === "string", "encoder.libjxlVersion", "encoder.libjxlVersion must be a string");
  assertField(Array.isArray(enc["flags"]), "encoder.flags", "encoder.flags must be an array");

  // saliency (optional; tighten ranges when present so scheduler boosts are safe)
  if (obj["saliency"] !== undefined) {
    assertField(
      typeof obj["saliency"] === "object" && obj["saliency"] !== null,
      "saliency",
      "saliency must be an object if present"
    );
    const s = obj["saliency"] as Record<string, unknown>;
    assertField(typeof s["enabled"] === "boolean", "saliency.enabled", "saliency.enabled must be a boolean");
    assertField(
      typeof s["centerX"] === "number" && (s["centerX"] as number) >= 0 && (s["centerX"] as number) <= 1,
      "saliency.centerX",
      "saliency.centerX must be number in [0,1]"
    );
    assertField(
      typeof s["centerY"] === "number" && (s["centerY"] as number) >= 0 && (s["centerY"] as number) <= 1,
      "saliency.centerY",
      "saliency.centerY must be number in [0,1]"
    );
    assertField(
      typeof s["confidence"] === "number" && (s["confidence"] as number) >= 0 && (s["confidence"] as number) <= 1,
      "saliency.confidence",
      "saliency.confidence must be number in [0,1]"
    );
    assertField(typeof s["method"] === "string", "saliency.method", "saliency.method must be a string");
  }

  // perceptual passthrough (optional, loose for future color science transport)
  if (obj["perceptual"] !== undefined) {
    assertField(
      typeof obj["perceptual"] === "object" && obj["perceptual"] !== null && !Array.isArray(obj["perceptual"]),
      "perceptual",
      "perceptual must be an object if present"
    );
  }

  // tiers
  assertField(Array.isArray(obj["tiers"]), "tiers", "tiers must be an array");
  const tiersArr = obj["tiers"] as unknown[];
  assertField(tiersArr.length > 0, "tiers", "tiers must not be empty");

  for (let i = 0; i < tiersArr.length; i++) {
    const t = tiersArr[i] as Record<string, unknown>;
    const f = `tiers[${i}]`;
    assertField(typeof t === "object" && t !== null, f, `${f} must be an object`);
    assertField(VALID_TIER_NAMES.has(t["name"] as string), `${f}.name`, `${f}.name must be dc|preview|full`);
    assertField(typeof t["byteStart"] === "number", `${f}.byteStart`, `${f}.byteStart must be a number`);
    assertField(typeof t["byteEnd"] === "number", `${f}.byteEnd`, `${f}.byteEnd must be a number`);
    assertField(
      typeof t["progressionIndex"] === "number" || t["progressionIndex"] === "final",
      `${f}.progressionIndex`,
      `${f}.progressionIndex must be number or "final"`,
    );
    assertField(typeof t["intendedUse"] === "string", `${f}.intendedUse`, `${f}.intendedUse must be a string`);
  }

  return json as ProgressiveManifest;
}

export function lookupTier(
  manifest: ProgressiveManifest,
  name: TierName,
): ManifestTier | undefined {
  return manifest.tiers.find((t) => t.name === name);
}

export async function checkHash(
  manifest: ProgressiveManifest,
  jxlBytes: ArrayBuffer,
): Promise<boolean> {
  let hashHex: string;

  if (
    typeof globalThis.crypto !== "undefined" &&
    typeof globalThis.crypto.subtle?.digest === "function"
  ) {
    const hashBuf = await globalThis.crypto.subtle.digest("SHA-256", jxlBytes);
    hashHex = Array.from(new Uint8Array(hashBuf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  } else {
    // Node.js fallback (crypto.subtle not available or not cross-origin-isolated)
    const { createHash } = await import("node:crypto");
    hashHex = createHash("sha256")
      .update(Buffer.from(jxlBytes))
      .digest("hex");
  }

  return hashHex === manifest.jxl.sha256;
}

export function migrateManifest(json: unknown): ProgressiveManifest {
  if (typeof json === "object" && json !== null) {
    const v = (json as Record<string, unknown>)["version"];
    if (typeof v === "number" && v > 1) {
      throw new ManifestValidationError(
        `Cannot migrate manifest version ${v} (only version 1 supported)`,
        "version",
      );
    }
  }
  return validateManifest(json);
}
