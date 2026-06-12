export type FixtureColorSpace = 'srgb' | 'adobe-rgb' | 'display-p3' | 'gray' | 'xyb';

export type FixtureTag =
  | 'basic' | 'srgb' | 'alpha' | 'scientific' | '16bit' | 'icc' | 'exif'
  | 'truncated' | 'malformed' | 'lossless' | 'archival' | 'progressive'
  | 'dc-only' | 'ar-latency' | 'gray-ramp' | 'gamut-green' | 'colour-engine'
  | 'multiview' | 'photogrammetry' | 'digital-twin';

export interface FixtureManifest {
  id: string;
  filename: string;
  url?: string;
  license: string;
  width?: number;
  height?: number;
  bitsPerSample: 8 | 16 | 32;
  colorSpace: FixtureColorSpace;
  hasAlpha: boolean;
  hasIcc: boolean;
  hasExif: boolean;
  hasXmp: boolean;
  expectedPass: boolean;
  expectedError?: string;   // substring or error code expected from libjxl's "error" decode event
  tags: FixtureTag[];
  sha256?: string;
  groupId?: string;         // fixtures sharing a groupId depict the same subject
  viewIndex?: number;       // ordering within the group
  attribution?: string;     // creator credit, alongside license
  occurrenceId?: string;    // Darwin Core occurrence linkage
  description?: string;     // human/LLM-readable content summary for semantic fixture selection
  expectedPixelsSha256?: string; // SHA-256 of the canonical decoded RGBA8 buffer — golden-image hash
}

export interface CorpusManifest {
  version: number;
  fixtures: FixtureManifest[];
}

export interface PgoScenario {
  name: string;
  weight: number;            // fraction of training mix; all weights must sum to 1.0
  op: 'encode-tiles' | 'encode-pyramid' | 'encode-container' | 'encode' | 'decode';
  files: string[];           // globs relative to the package root
  effort: number;
  levels?: number;
  note?: string;
}

export interface PgoScenarioManifest {
  version: 2;
  scenarios: PgoScenario[];
  generated?: {
    at: string;
    sources: Array<{
      source: string;
      full: { width: number; height: number };
      tile: { width: number; height: number };
    }>;
  };
}
