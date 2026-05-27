import wasmFactoryEnc from "../dist/heic-enc.js";
import wasmFactoryDec from "../dist/heic-dec.js";
import { check, encodeES, loadES } from "./common.js";
export const Presets = ["ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow", "slower", "veryslow", "placebo"];
export const Subsampling = ["420", "422", "444"];
export const Tune = ["psnr", "ssim", "grain", "fastdecode"];
export const defaultOptions = {
    quality: 50,
    lossless: false,
    preset: "slow",
    tune: "ssim",
    tuIntraDepth: 2,
    complexity: 50,
    chroma: "420",
    sharpYUV: false,
};
export const mimeType = "image/heic";
export const extension = "heic";
export const bitDepth = [8, 10, 12];
let encoderWASM;
let decoderWASM;
export async function loadEncoder(input) {
    return encoderWASM ??= await loadES(wasmFactoryEnc, input);
}
export async function loadDecoder(input) {
    return decoderWASM ??= await loadES(wasmFactoryDec, input);
}
export function encode(image, options) {
    return encodeES("HEIC Encode", encoderWASM, defaultOptions, image, options);
}
export function decode(input) {
    return check(decoderWASM.decode(input), "HEIC Decode");
}
