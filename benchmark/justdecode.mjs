import { open, readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import sharp from 'sharp';

const ORF_PATH = String.raw`c:\995\2026-02-20 Gobabeb To Windhoek\P2200476 Pogonospermum cleomoides.ORF`;
const WASM_JS_URL = new URL('./pkg/raw_converter_wasm.js', import.meta.url);
const WASM_BIN_URL = new URL('./pkg/raw_converter_wasm_bg.wasm', import.meta.url);

// Fallback byte-scan window if IFD parse finds no preview.
const SCAN_BYTES = 8 * 1024 * 1024;
const MIN_JPEG_BYTES = 1024;
const MAX_IFDS = 16;       // cycle guard
const MAX_IFD_ENTRIES = 512;
const MAX_SUBIFDS = 8;

// TIFF tag IDs.
const TAG_NEW_SUBFILE_TYPE      = 0x00FE;
const TAG_COMPRESSION           = 0x0103;
const TAG_STRIP_OFFSETS         = 0x0111;
const TAG_STRIP_BYTE_COUNTS     = 0x0117;
const TAG_JPEG_IF_OFFSET        = 0x0201; // JPEGInterchangeFormat
const TAG_JPEG_IF_LENGTH        = 0x0202; // JPEGInterchangeFormatLength
const TAG_SUB_IFDS              = 0x014A;
const TAG_EXIF_IFD              = 0x8769;
const TAG_MAKERNOTE             = 0x927C;

const COMPRESSION_JPEG_OLD      = 6;
const COMPRESSION_JPEG_NEW      = 7;

const TIFF_TYPE_SIZE = {
    1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8,
};

class TiffWalker {
    /**
     * @param {import('node:fs/promises').FileHandle} fh
     * @param {number} size file size in bytes
     */
    constructor(fh, size) {
        this.fh = fh;
        this.size = size;
        this.little = true;
        this.headerBuf = Buffer.allocUnsafe(8);
    }

    async init() {
        await this.fh.read(this.headerBuf, 0, 8, 0);
        const b0 = this.headerBuf[0];
        const b1 = this.headerBuf[1];
        if (b0 === 0x49 && b1 === 0x49) this.little = true;        // 'II'
        else if (b0 === 0x4D && b1 === 0x4D) this.little = false;  // 'MM'
        else throw new Error(`not TIFF (bytes 0..1 = ${b0.toString(16)} ${b1.toString(16)})`);

        const magic = this.little ? this.headerBuf.readUInt16LE(2) : this.headerBuf.readUInt16BE(2);
        // 0x002A = TIFF; 0x4F52/0x5352 = Olympus ORF variants (still TIFF-compatible).
        if (magic !== 0x002A && magic !== 0x4F52 && magic !== 0x5352) {
            throw new Error(`unknown TIFF magic 0x${magic.toString(16)}`);
        }
        this.ifd0Offset = this.little ? this.headerBuf.readUInt32LE(4) : this.headerBuf.readUInt32BE(4);
    }

    u16(buf, off) { return this.little ? buf.readUInt16LE(off) : buf.readUInt16BE(off); }
    u32(buf, off) { return this.little ? buf.readUInt32LE(off) : buf.readUInt32BE(off); }

    /**
     * Read one IFD. Returns { entries: Map<tag, {type,count,valueOrOffset,inlineBytes}>, nextOffset }.
     */
    async readIfd(offset) {
        if (offset === 0 || offset + 2 > this.size) return null;
        const countBuf = Buffer.allocUnsafe(2);
        await this.fh.read(countBuf, 0, 2, offset);
        const count = this.u16(countBuf, 0);
        if (count === 0 || count > MAX_IFD_ENTRIES) return null;

        const bodyLen = count * 12 + 4; // entries + next-IFD pointer
        if (offset + 2 + bodyLen > this.size) return null;
        const body = Buffer.allocUnsafe(bodyLen);
        await this.fh.read(body, 0, bodyLen, offset + 2);

        const entries = new Map();
        for (let i = 0; i < count; i++) {
            const o = i * 12;
            const tag = this.u16(body, o);
            const type = this.u16(body, o + 2);
            const c = this.u32(body, o + 4);
            const size = (TIFF_TYPE_SIZE[type] ?? 0) * c;
            const inline = body.subarray(o + 8, o + 12);
            const valueOrOffset = this.u32(body, o + 8);
            entries.set(tag, { type, count: c, size, inline, valueOrOffset });
        }
        const nextOffset = this.u32(body, count * 12);
        return { entries, nextOffset };
    }

    /**
     * Resolve a tag's value(s) as an array of u32. Handles inline (size <=4) and external.
     */
    async readTagU32(entry) {
        const { type, count, size, inline, valueOrOffset } = entry;
        const elemSize = TIFF_TYPE_SIZE[type] ?? 0;
        if (elemSize === 0 || count === 0) return [];

        const reader = (buf, off) => {
            switch (type) {
                case 1: case 6: case 7: return buf[off];
                case 3: case 8: return this.u16(buf, off);
                case 4: case 9: return this.u32(buf, off);
                default: return this.u32(buf, off);
            }
        };

        if (size <= 4) {
            const out = new Array(count);
            for (let i = 0; i < count; i++) out[i] = reader(inline, i * elemSize);
            return out;
        }
        if (valueOrOffset + size > this.size) return [];
        const buf = Buffer.allocUnsafe(size);
        await this.fh.read(buf, 0, size, valueOrOffset);
        const out = new Array(count);
        for (let i = 0; i < count; i++) out[i] = reader(buf, i * elemSize);
        return out;
    }

    /**
     * Walk IFD0 + its IFD chain + all SubIFDs. Collect JPEG preview candidates.
     * Returns array of { offset, length, source } sorted descending by length.
     */
    async collectPreviewCandidates() {
        const candidates = [];
        const visited = new Set();
        const queue = [{ offset: this.ifd0Offset, label: 'IFD0' }];
        let chainSteps = 0;

        while (queue.length && chainSteps < MAX_IFDS) {
            const { offset, label } = queue.shift();
            if (offset === 0 || visited.has(offset)) continue;
            visited.add(offset);
            chainSteps++;

            const ifd = await this.readIfd(offset);
            if (!ifd) continue;
            const { entries, nextOffset } = ifd;

            // (a) TIFF6 JPEGInterchangeFormat tags
            const jpegOff = entries.get(TAG_JPEG_IF_OFFSET);
            const jpegLen = entries.get(TAG_JPEG_IF_LENGTH);
            if (jpegOff && jpegLen) {
                const o = jpegOff.valueOrOffset;
                const l = jpegLen.valueOrOffset;
                if (o > 0 && l >= MIN_JPEG_BYTES && o + l <= this.size) {
                    candidates.push({ offset: o, length: l, source: `${label}/JPEGIF` });
                }
            }

            // (b) Compression=6/7 strip-based JPEGs
            const compEntry = entries.get(TAG_COMPRESSION);
            if (compEntry) {
                const comp = compEntry.size <= 4 ? this.u16(compEntry.inline, 0) : 0;
                if (comp === COMPRESSION_JPEG_OLD || comp === COMPRESSION_JPEG_NEW) {
                    const offsEntry = entries.get(TAG_STRIP_OFFSETS);
                    const lensEntry = entries.get(TAG_STRIP_BYTE_COUNTS);
                    if (offsEntry && lensEntry) {
                        const offs = await this.readTagU32(offsEntry);
                        const lens = await this.readTagU32(lensEntry);
                        // Single-strip JPEG = the typical preview layout.
                        if (offs.length === 1 && lens.length === 1) {
                            const o = offs[0], l = lens[0];
                            if (o > 0 && l >= MIN_JPEG_BYTES && o + l <= this.size) {
                                candidates.push({ offset: o, length: l, source: `${label}/Strip` });
                            }
                        }
                    }
                }
            }

            // (c) SubIFDs — Olympus stores full-res preview here
            const subEntry = entries.get(TAG_SUB_IFDS);
            if (subEntry) {
                const subs = await this.readTagU32(subEntry);
                for (let i = 0; i < subs.length && i < MAX_SUBIFDS; i++) {
                    queue.push({ offset: subs[i], label: `${label}/SubIFD[${i}]` });
                }
            }

            // (d) IFD chain
            if (nextOffset !== 0) queue.push({ offset: nextOffset, label: 'IFDn' });
        }

        // Validate each candidate: must start with FF D8 FF.
        const validated = [];
        for (const c of candidates) {
            const head = Buffer.allocUnsafe(3);
            await this.fh.read(head, 0, 3, c.offset);
            if (head[0] === 0xFF && head[1] === 0xD8 && head[2] === 0xFF) {
                validated.push(c);
            }
        }
        validated.sort((a, b) => b.length - a.length);
        return validated;
    }
}

/**
 * Fallback: scan raw bytes for SOI...EOI pairs.
 */
function scanEmbeddedJpegs(chunk, minBytes = MIN_JPEG_BYTES) {
    const sois = [];
    let i = 0;
    const last = chunk.length - 2;
    while (i < last) {
        if (chunk[i] === 0xFF && chunk[i + 1] === 0xD8 && chunk[i + 2] === 0xFF) {
            sois.push(i);
            i += 3;
        } else {
            i++;
        }
    }
    let smallest = null, largest = null;
    for (let n = 0; n < sois.length; n++) {
        const start = sois[n];
        const end = (n + 1 < sois.length) ? sois[n + 1] : chunk.length;
        let eoi = -1;
        for (let j = end - 1; j > start + 1; j--) {
            if (chunk[j - 1] === 0xFF && chunk[j] === 0xD9) { eoi = j + 1; break; }
        }
        if (eoi === -1) continue;
        const len = eoi - start;
        if (len < minBytes) continue;
        const view = chunk.subarray(start, eoi);
        if (smallest === null || len < smallest.length) smallest = view;
        if (largest === null || len > largest.length) largest = view;
    }
    return { smallest, largest };
}

function stamp(t0, label) {
    const ms = performance.now() - t0;
    console.log(`[t+${ms.toFixed(2).padStart(8)} ms] ${label}`);
    return ms;
}

async function main() {
    const t0 = performance.now();
    console.log(`Opening ${ORF_PATH}`);

    const fh = await open(ORF_PATH, 'r');
    let restPromise = null;
    let fullBufPromise = null;
    let totalSize = 0;

    try {
        const stat = await fh.stat();
        totalSize = stat.size;
        stamp(t0, `Opened (${totalSize} bytes)`);

        // --- FAST PATH via IFD parse ---
        const walker = new TiffWalker(fh, totalSize);
        await walker.init();
        stamp(t0, `TIFF header parsed (${walker.little ? 'LE' : 'BE'}, IFD0 @ ${walker.ifd0Offset})`);

        const candidates = await walker.collectPreviewCandidates();
        stamp(t0, `IFD walk found ${candidates.length} preview candidate(s)`);
        for (const c of candidates) {
            console.log(`  ${c.source}: offset=${c.offset} length=${c.length}`);
        }

        let previewBuf = null;
        let previewSource = null;

        if (candidates.length > 0) {
            // Largest validated preview = full-resolution image.
            const top = candidates[0];
            const buf = Buffer.allocUnsafe(top.length);
            await fh.read(buf, 0, top.length, top.offset);
            previewBuf = buf;
            previewSource = top.source;
            stamp(t0, `Read full preview JPEG (${top.length} bytes, ${top.source})`);
        }

        // Kick rest-of-file read in background regardless of fast-path outcome.
        // (WASM decode still wants the full buffer.)
        fullBufPromise = fh.readFile();

        // Fallback to byte scan if IFD parse found nothing.
        if (!previewBuf) {
            console.log('IFD parse: no preview — falling back to byte scan');
            const scanLen = Math.min(SCAN_BYTES, totalSize);
            const scanBuf = Buffer.allocUnsafe(scanLen);
            await fh.read(scanBuf, 0, scanLen, 0);
            const { largest } = scanEmbeddedJpegs(scanBuf);
            if (largest) {
                previewBuf = Buffer.from(largest);
                previewSource = 'byte-scan';
                stamp(t0, `Byte scan found preview (${largest.length} bytes)`);
            } else {
                stamp(t0, `Byte scan found no preview`);
            }
        }

        if (previewBuf) {
            const t1 = performance.now();
            await writeFile('preview-full.jpg', previewBuf);
            stamp(t0, `Wrote preview-full.jpg (+${(performance.now() - t1).toFixed(2)} ms write, ${previewSource})`);
        }

        // --- WASM init in parallel with rest-of-file read ---
        const wasmReady = (async () => {
            const [mod, wasmBytes] = await Promise.all([
                import(WASM_JS_URL.href),
                readFile(WASM_BIN_URL),
            ]);
            await mod.default({ module_or_path: wasmBytes });
            return mod;
        })();

        const [fullBuf, mod] = await Promise.all([fullBufPromise, wasmReady]);
        stamp(t0, `WASM ready + full file in memory (${fullBuf.length} bytes)`);

        const { process_orf_with_flags, downscale_rgb } = mod;

        // --- SLOW PATH: WASM full decode ---
        const tWasm0 = performance.now();
        const result = process_orf_with_flags(
            fullBuf,
            1, // OUT_FULL_RGB8
            0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            Number.NaN, Number.NaN, 0, 0,
        );
        const decodeMs = performance.now() - tWasm0;
        stamp(t0, `WASM full decode (${decodeMs.toFixed(2)} ms work)`);
        console.log(`  decompress: ${result.decompress_ms.toFixed(2)} ms`);
        console.log(`  demosaic:   ${result.demosaic_ms.toFixed(2)} ms`);
        console.log(`  tonemap:    ${result.tonemap_ms.toFixed(2)} ms`);
        console.log(`  orient:     ${result.orient_ms.toFixed(2)} ms`);

        const rgb = result.take_rgb();
        const w = result.width;
        const h = result.height;
        const thumbW = Math.round(w / 4);
        const thumbH = Math.round(h / 4);
        const thumbRgb = downscale_rgb(rgb, w, h, thumbW, thumbH);

        await sharp(Buffer.from(thumbRgb), {
            raw: { width: thumbW, height: thumbH, channels: 3 },
        }).png().toFile('wasm-thumbnail.png');
        stamp(t0, `Wrote wasm-thumbnail.png (${thumbW}x${thumbH})`);

        result.free();
    } finally {
        await fh.close();
    }

    stamp(t0, 'Done.');
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
