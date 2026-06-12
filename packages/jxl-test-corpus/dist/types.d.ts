export type FixtureColorSpace = 'srgb' | 'adobe-rgb' | 'display-p3' | 'gray' | 'xyb';
export type FixtureTag = 'basic' | 'srgb' | 'alpha' | 'scientific' | '16bit' | 'icc' | 'exif' | 'truncated' | 'malformed' | 'lossless' | 'archival' | 'progressive' | 'dc-only' | 'ar-latency' | 'gray-ramp' | 'gamut-green' | 'colour-engine' | 'multiview' | 'photogrammetry' | 'digital-twin';
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
    expectedError?: string;
    tags: FixtureTag[];
    sha256?: string;
    groupId?: string;
    viewIndex?: number;
    attribution?: string;
    occurrenceId?: string;
    description?: string;
    expectedPixelsSha256?: string;
}
export interface CorpusManifest {
    version: number;
    fixtures: FixtureManifest[];
}
export interface PgoScenario {
    name: string;
    weight: number;
    op: 'encode-tiles' | 'encode-pyramid' | 'encode-container' | 'encode' | 'decode';
    files: string[];
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
            full: {
                width: number;
                height: number;
            };
            tile: {
                width: number;
                height: number;
            };
        }>;
    };
}
