import { FixtureManifest } from './types.js';
import { manifest as corpusManifest } from './manifest.js';

const isNode = typeof process !== 'undefined' && process.versions && process.versions.node;

const byId = new Map<string, FixtureManifest>(corpusManifest.fixtures.map(f => [f.id, f]));
const cache = new Map<string, Promise<{ bytes: Uint8Array, fixture: FixtureManifest, /** @deprecated Use fixture instead */ manifest: FixtureManifest }>>();

/**
 * Filtered query API for retrieving matching fixtures from the manifest
 */
export function getFixtures(filter?: { tag?: string; expectedPass?: boolean }): FixtureManifest[] {
  let out = corpusManifest.fixtures;
  if (filter?.tag) {
    out = out.filter(f => (f.tags as string[]).includes(filter.tag!));
  }
  if (filter?.expectedPass !== undefined) {
    out = out.filter(f => f.expectedPass === filter.expectedPass);
  }
  return out;
}

/**
 * Verifies the SHA-256 hash of a buffer against an expected hex string.
 * Guards against the absence of WebCrypto (e.g. insecure contexts in browsers).
 */
async function verifySha256(bytes: Uint8Array, expected: string, id: string): Promise<void> {
  if (typeof crypto === 'undefined' || !crypto.subtle) {
    // Under Node or secure browser contexts, crypto.subtle is available.
    // If it is missing, we throw an actionable error.
    throw new Error(`crypto.subtle unavailable (insecure browser context?) — cannot verify fixture ${id}`);
  }
  const digestBuffer = await crypto.subtle.digest('SHA-256', bytes);
  const digestArray = Array.from(new Uint8Array(digestBuffer));
  const hex = digestArray.map(b => b.toString(16).padStart(2, '0')).join('');
  if (hex !== expected) {
    throw new Error(`SHA-256 mismatch for fixture ${id}: expected ${expected}, got ${hex}`);
  }
}

export async function loadFixture(id: string): Promise<{ bytes: Uint8Array, fixture: FixtureManifest, /** @deprecated Use fixture instead */ manifest: FixtureManifest }> {
  const existing = cache.get(id);
  if (existing) {
    return existing;
  }

  const p = (async () => {
    const fixture = byId.get(id);
    if (!fixture) {
      throw new Error(`Fixture not found: ${id}`);
    }

    let bytes: Uint8Array;
    if (isNode) {
      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      const url = await import('node:url');
      const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
      // Resolve relative to package root (fixtures/ lives at root, while src/ and dist/ are siblings)
      const filePath = path.join(__dirname, '..', 'fixtures', fixture.filename);
      try {
        const buffer = await fs.readFile(filePath);
        bytes = new Uint8Array(buffer);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new Error(
            `Fixture file missing: ${filePath}. Run "npm run generate:fixtures" in packages/jxl-test-corpus (corpus binaries are generated, not checked in).`
          );
        }
        throw e;
      }
    } else {
      // Browser path: assume fixtures are served at /fixtures/ relative to the loader
      const url = new URL(`./fixtures/${fixture.filename}`, import.meta.url);
      const response = await fetch(url.href);
      if (!response.ok) {
        throw new Error(`Failed to fetch fixture: ${fixture.filename} (status: ${response.status})`);
      }
      const arrayBuffer = await response.arrayBuffer();
      bytes = new Uint8Array(arrayBuffer);
    }

    if (fixture.sha256) {
      await verifySha256(bytes, fixture.sha256, id);
    }

    return { bytes, fixture, manifest: fixture };
  })();

  cache.set(id, p);
  return p;
}

export interface FetchLargeFixtureOptions {
  onProgress?: (loaded: number, total: number) => void;
}

export async function fetchLargeFixture(
  id: string,
  options?: FetchLargeFixtureOptions
): Promise<{ bytes: Uint8Array, fixture: FixtureManifest, /** @deprecated Use fixture instead */ manifest: FixtureManifest }> {
  const fixture = byId.get(id);
  if (!fixture) throw new Error(`Fixture not found: ${id}`);
  if (!fixture.url) throw new Error(`Fixture ${id} has no remote URL`);

  const response = await fetch(fixture.url);
  if (!response.ok) throw new Error(`Failed to fetch large fixture: ${id} (status: ${response.status})`);

  let bytes: Uint8Array;
  const totalStr = response.headers.get('content-length');
  const total = totalStr ? parseInt(totalStr, 10) : 0;

  if (options?.onProgress && response.body) {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let loaded = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        loaded += value.byteLength;
        options.onProgress(loaded, total || loaded);
      }
    }

    bytes = new Uint8Array(loaded);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
  } else {
    const arrayBuffer = await response.arrayBuffer();
    bytes = new Uint8Array(arrayBuffer);
    if (options?.onProgress && total) {
      options.onProgress(bytes.byteLength, total);
    }
  }

  if (fixture.sha256) {
    await verifySha256(bytes, fixture.sha256, id);
  }

  return { bytes, fixture, manifest: fixture };
}
