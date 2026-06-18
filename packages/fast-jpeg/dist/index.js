import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { existsSync } from 'node:fs';
// Walk up from this compiled file's directory to find the nearest ancestor with package.json.
// This normalises the WASM path regardless of outDir depth (dist/ vs dist-test/src/).
function _findPkgRoot(start) {
    let d = start;
    while (d !== path.dirname(d)) {
        if (existsSync(path.join(d, 'package.json')))
            return d;
        d = path.dirname(d);
    }
    return d;
}
const _pkgRoot = _findPkgRoot(path.dirname(fileURLToPath(import.meta.url)));
const _require = createRequire(import.meta.url);
// wasm-pack --target nodejs output; WASM loads synchronously at first require.
// Browser: rebuild crates/fast-jpeg with `wasm-pack --target web --out-dir pkg-web`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { decode_scaled: _decode } = _require(path.join(_pkgRoot, '../../crates/fast-jpeg/pkg/fast_jpeg.js'));
export class JpegDecodeError extends Error {
    code;
    cause;
    constructor(cause) {
        super(cause instanceof Error ? cause.message : String(cause));
        this.name = 'JpegDecodeError';
        this.code = 'decode_failed';
        this.cause = cause;
    }
}
/** Decode JPEG → RGBA8 with DCT-domain downscale. denom: 1=full, 2=half, 4=quarter, 8=eighth. */
export function decodeJpegScaled(jpeg, denom = 1) {
    let r;
    try {
        r = _decode(jpeg, denom);
        return { data: r.data, width: r.width, height: r.height };
    }
    catch (e) {
        if (e instanceof JpegDecodeError)
            throw e;
        throw new JpegDecodeError(e);
    }
    finally {
        r?.free();
    }
}
