export function loadES(factory, source) {
    return typeof source === "string"
        ? factory({ locateFile: () => source })
        : factory({ wasmBinary: source });
}
export function toBitDepth(image, value) {
    const { data, width, height, depth = 8 } = image;
    if (value === depth) {
        return image;
    }
    const pixels = width * height * 4;
    const dist = value === 8
        ? new Uint8ClampedArray(pixels)
        : new Uint16Array(pixels);
    const view = depth === 8
        ? data
        : new Uint16Array(data.buffer, data.byteOffset);
    const from = (1 << depth) - 1;
    const to = (1 << value) - 1;
    for (let i = 0; i < pixels; i++) {
        dist[i] = view[i] / from * to + 0.5;
    }
    const nd = new Uint8ClampedArray(dist.buffer, dist.byteOffset, dist.byteLength);
    return _icodec_ImageData(nd, width, height, value);
}
/**
 * Node does not have `ImageData` class, so we define a pure version.
 */
export class PureImageData {
    data;
    width;
    height;
    depth;
    constructor(data, width, height, depth = 8) {
        this.data = data;
        this.width = width;
        this.height = height;
        this.depth = depth;
    }
}
// @ts-expect-error
PureImageData.prototype.colorSpace = "srgb";
export function encodeES(name, wasm, defaults, image, options) {
    options = { ...defaults, ...options };
    const { data, width, height } = image;
    options.bitDepth = image.depth ?? 8;
    const result = wasm.encode(data, width, height, options);
    return check(result, name);
}
export function check(value, hint) {
    if (typeof value === "string") {
        throw new Error(`${hint}: ${value}`);
    }
    if (value)
        return value;
    else
        throw new Error(hint + " failed");
}
