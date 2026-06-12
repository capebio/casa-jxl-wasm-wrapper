import { FixtureManifest } from './types.js';
/**
 * Filtered query API for retrieving matching fixtures from the manifest
 */
export declare function getFixtures(filter?: {
    tag?: string;
    expectedPass?: boolean;
}): FixtureManifest[];
export declare function loadFixture(id: string): Promise<{
    bytes: Uint8Array;
    fixture: FixtureManifest; /** @deprecated Use fixture instead */
    manifest: FixtureManifest;
}>;
export interface FetchLargeFixtureOptions {
    onProgress?: (loaded: number, total: number) => void;
}
export declare function fetchLargeFixture(id: string, options?: FetchLargeFixtureOptions): Promise<{
    bytes: Uint8Array;
    fixture: FixtureManifest; /** @deprecated Use fixture instead */
    manifest: FixtureManifest;
}>;
