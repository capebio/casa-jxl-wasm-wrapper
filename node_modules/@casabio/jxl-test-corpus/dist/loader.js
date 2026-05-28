import { manifest } from './manifest.js';
const isNode = typeof process !== 'undefined' && process.versions && process.versions.node;
export async function loadFixture(id) {
    const fixture = manifest.fixtures.find(f => f.id === id);
    if (!fixture) {
        throw new Error(`Fixture not found: ${id}`);
    }
    let bytes;
    if (isNode) {
        const fs = await import('node:fs/promises');
        const path = await import('node:path');
        const url = await import('node:url');
        const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
        const filePath = path.join(__dirname, 'fixtures', fixture.filename);
        const buffer = await fs.readFile(filePath);
        bytes = new Uint8Array(buffer);
    }
    else {
        // Browser path: assume fixtures are served at /fixtures/ relative to the loader
        const url = new URL(`./fixtures/${fixture.filename}`, import.meta.url);
        const response = await fetch(url.href);
        if (!response.ok)
            throw new Error(`Failed to fetch fixture: ${fixture.filename}`);
        const arrayBuffer = await response.arrayBuffer();
        bytes = new Uint8Array(arrayBuffer);
    }
    return { bytes, manifest: fixture };
}
export async function fetchLargeFixture(id) {
    const fixture = manifest.fixtures.find(f => f.id === id);
    if (!fixture)
        throw new Error(`Fixture not found: ${id}`);
    if (!fixture.url)
        throw new Error(`Fixture ${id} has no remote URL`);
    const response = await fetch(fixture.url);
    if (!response.ok)
        throw new Error(`Failed to fetch large fixture: ${id}`);
    const arrayBuffer = await response.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    if (fixture.sha256) {
        const hashBuffer = await crypto.subtle.digest('SHA-256', bytes);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
        if (hashHex !== fixture.sha256) {
            throw new Error(`SHA-256 mismatch for fixture ${id}`);
        }
    }
    return { bytes, manifest: fixture };
}
