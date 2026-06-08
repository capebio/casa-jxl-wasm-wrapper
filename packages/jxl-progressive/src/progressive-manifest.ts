// packages/jxl-progressive/src/progressive-manifest.ts

export type TierName = "dc" | "preview" | "full";

// --- Phase 8 type imports (schema re-exports for FrameSet + capture geometry) ---
// Data model defined in types.ts per handoff spec; re-exported here so progressive-manifest remains the schema surface.
import type {
  CameraPose,
  Relation,
  FrameSetMember,
  FrameSet,
  AssetChannel,
  ChannelDescriptor,
} from "./types.js";

export type { CameraPose, Relation, FrameSetMember, FrameSet, AssetChannel, ChannelDescriptor };

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
  tiers: ManifestTier[];

  // Phase 8: reserved ingest CV fields + channel semantics (PG2/PG4/PG5/ST8).
  // Populated for photogrammetry/transect assets; FrameSet groups multiple such manifests.
  // These are optional and forward-compat; validateManifest passes through unknown optionals.
  capture?: {
    pose?: CameraPose;
    intrinsics?: FrameSetMember["intrinsics"];
    extrinsics?: FrameSetMember["extrinsics"];
    depthLayer?: FrameSetMember["depthLayer"];
    featureSidecar?: FrameSetMember["featureSidecar"];
  };
  /** Concurrent loadable channels alongside rgb (PG4). */
  channels?: AssetChannel[];
  channelDescriptors?: ChannelDescriptor[];
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
