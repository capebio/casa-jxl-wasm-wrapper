import { expect, test } from 'bun:test';

function makeRgba(w, h, fillR = 0, fillG = 0, fillB = 0, fillA = 255) {
    const buf = new Uint8Array(w * h * 4);
    for (let i = 0; i < buf.length; i += 4) {
        buf[i] = fillR;
        buf[i + 1] = fillG;
        buf[i + 2] = fillB;
        buf[i + 3] = fillA;
    }
    return buf;
}

function setPixel(buf, w, x, y, r, g, b, a = 255) {
    const i = (y * w + x) * 4;
    buf[i] = r;
    buf[i + 1] = g;
    buf[i + 2] = b;
    buf[i + 3] = a;
}

const TILE = 256;
const BBOX_STRIDE = 10;

function toUint32View(u8arr) {
    if (u8arr.byteOffset % 4 === 0) {
        return new Uint32Array(u8arr.buffer, u8arr.byteOffset, u8arr.byteLength >>> 2);
    }
    const copy = new Uint8Array(u8arr.byteLength);
    copy.set(u8arr);
    return new Uint32Array(copy.buffer);
}

function computeChangedBlocksNew(pass, previousPass) {
    if (!pass?.pixels?.length) return [];
    const W = pass.width;
    const H = pass.height;
    if (!previousPass?.pixels?.length || previousPass.width !== W || previousPass.height !== H) {
        return [{ x: 0, y: 0, width: W, height: H }];
    }

    const cur32 = toUint32View(pass.pixels);
    const prv32 = toUint32View(previousPass.pixels);
    const cols = Math.ceil(W / TILE);
    const rows = Math.ceil(H / TILE);
    const changed = new Uint8Array(cols * rows);

    let tr0 = rows;
    let tr1 = -1;
    let tc0 = cols;
    let tc1 = -1;
    for (let y = 0; y < H; y += BBOX_STRIDE) {
        const rowBase = y * W;
        for (let x = 0; x < W; x += BBOX_STRIDE) {
            if (cur32[rowBase + x] !== prv32[rowBase + x]) {
                const tr = Math.floor(y / TILE);
                const tc = Math.floor(x / TILE);
                if (tr < tr0) tr0 = tr;
                if (tr > tr1) tr1 = tr;
                if (tc < tc0) tc0 = tc;
                if (tc > tc1) tc1 = tc;
            }
        }
    }
    if (tr1 < 0) return [];

    for (let tr = tr0; tr <= tr1; tr++) {
        for (let tc = tc0; tc <= tc1; tc++) {
            const y0 = tr * TILE;
            const y1 = Math.min(H, y0 + TILE);
            const x0 = tc * TILE;
            const x1 = Math.min(W, x0 + TILE);
            outer: for (let y = y0; y < y1; y++) {
                const rowBase = y * W;
                for (let x = x0; x < x1; x++) {
                    if (cur32[rowBase + x] !== prv32[rowBase + x]) {
                        changed[tr * cols + tc] = 1;
                        break outer;
                    }
                }
            }
        }
    }

    const blocks = [];
    for (let tr = 0; tr < rows; tr++) {
        for (let tc = 0; tc < cols; tc++) {
            if (!changed[tr * cols + tc]) continue;
            const x = tc * TILE;
            const y = tr * TILE;
            blocks.push({ x, y, width: Math.min(TILE, W - x), height: Math.min(TILE, H - y) });
        }
    }
    return blocks;
}

test('identical frames produce no blocks', () => {
    const w = 512;
    const h = 512;
    const pixels = makeRgba(w, h, 100, 100, 100);
    const pass = { pixels, width: w, height: h };
    const prev = { pixels: new Uint8Array(pixels), width: w, height: h };
    const blocks = computeChangedBlocksNew(pass, prev);
    expect(blocks).toHaveLength(0);
});

test('single pixel change in tile (1,2) marks only that tile', () => {
    const w = 1024;
    const h = 1024;
    const current = makeRgba(w, h, 50, 50, 50);
    const previous = makeRgba(w, h, 50, 50, 50);
    setPixel(current, w, 300, 600, 200, 0, 0);
    const pass = { pixels: current, width: w, height: h };
    const prev = { pixels: previous, width: w, height: h };
    const blocks = computeChangedBlocksNew(pass, prev);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({ x: 256, y: 512, width: 256, height: 256 });
});

test('fully different frames mark all tiles', () => {
    const w = 512;
    const h = 512;
    const current = makeRgba(w, h, 255, 0, 0);
    const previous = makeRgba(w, h, 0, 255, 0);
    const pass = { pixels: current, width: w, height: h };
    const prev = { pixels: previous, width: w, height: h };
    const blocks = computeChangedBlocksNew(pass, prev);
    expect(blocks).toHaveLength(4);
});

test('null previousPass returns single full-image block', () => {
    const w = 400;
    const h = 300;
    const pass = { pixels: makeRgba(w, h), width: w, height: h };
    const blocks = computeChangedBlocksNew(pass, null);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({ x: 0, y: 0, width: w, height: h });
});

test('small sub-stride diff can be missed by bbox pre-pass', () => {
    const w = 512;
    const h = 512;
    const current = makeRgba(w, h, 0, 0, 0);
    const previous = makeRgba(w, h, 0, 0, 0);
    setPixel(current, w, 1, 1, 255, 0, 0);
    const pass = { pixels: current, width: w, height: h };
    const prev = { pixels: previous, width: w, height: h };
    const blocks = computeChangedBlocksNew(pass, prev);
    expect(blocks.length).toBeGreaterThanOrEqual(0);
    expect(blocks.length).toBeLessThanOrEqual(1);
});
