import { createDecoder, encodeRgba8Pyramid, encodeTileContainerRgba8, transcodeJpegToJxl } from "@casabio/jxl-wasm";
export function createJxlBackend() {
    return {
        async encodePyramid(rgba, width, height, opts) {
            const levels = await encodeRgba8Pyramid(rgba, width, height, {
                fullDistance: opts.fullDistance,
                sidecarSizes: opts.sidecarSizes,
                sidecarDistances: opts.sidecarDistances,
                effort: opts.effort,
                hasAlpha: false,
                resampling: 1,
            });
            return levels.map((l) => ({ data: l.data, width: l.width, height: l.height }));
        },
        async encodeTileContainer(rgba, width, height, opts) {
            return encodeTileContainerRgba8(rgba, width, height, {
                tileSize: opts.tileSize,
                distance: opts.distance,
                effort: opts.effort,
                hasAlpha: false,
            });
        },
        async transcodeJpeg(jpeg) {
            return transcodeJpegToJxl(jpeg);
        },
        async decodeToRgba8(jxl) {
            const decoder = createDecoder({
                format: "rgba8",
                progressionTarget: "final",
                emitEveryPass: false,
                preserveIcc: false,
                preserveMetadata: false,
            });
            let result = null;
            const drain = (async () => {
                for await (const ev of decoder.events()) {
                    if (ev.type === "final") {
                        const px = ev.pixels instanceof Uint8Array ? ev.pixels : new Uint8Array(ev.pixels);
                        result = { rgba: px, width: ev.info.width, height: ev.info.height };
                    }
                    else if (ev.type === "error") {
                        throw new Error(`decode ${ev.code}: ${ev.message}`);
                    }
                }
            })();
            await decoder.push(jxl);
            await decoder.close();
            await drain;
            await decoder.dispose();
            if (!result)
                throw new Error("decode produced no final frame");
            return result;
        },
    };
}
//# sourceMappingURL=backends.js.map