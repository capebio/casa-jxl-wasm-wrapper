export interface FixtureManifest {
    id: string;
    filename: string;
    url?: string;
    license: string;
    width: number;
    height: number;
    bitsPerSample: 8 | 16 | 32;
    colorSpace: string;
    hasAlpha: boolean;
    hasIcc: boolean;
    hasExif: boolean;
    hasXmp: boolean;
    expectedPass: boolean;
    tags: string[];
    sha256?: string;
}
export interface CorpusManifest {
    fixtures: FixtureManifest[];
}
