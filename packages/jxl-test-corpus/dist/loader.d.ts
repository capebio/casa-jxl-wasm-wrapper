import { FixtureManifest } from './types.js';
export declare function loadFixture(id: string): Promise<{
    bytes: Uint8Array;
    manifest: FixtureManifest;
}>;
export declare function fetchLargeFixture(id: string): Promise<{
    bytes: Uint8Array;
    manifest: FixtureManifest;
}>;
