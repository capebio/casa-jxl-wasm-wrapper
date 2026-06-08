import { decodeTileContainerRegionRgba8 } from "@casabio/jxl-wasm";
import {
  canUseParallelTileWorkers,
  parseJxtcHeader,
  tilesOverlappingRegion,
  type ImageRegion,
} from "./tiling.js";
import type { DecodedLevel } from "./decode-level.js";

type WorkerLike = {
  addEventListener(type: "message", listener: (ev: { data: WorkerReply }) => void): void;
  removeEventListener(type: "message", listener: (ev: { data: WorkerReply }) => void): void;
  postMessage(data: { id: number; bytes: Uint8Array; region: ImageRegion }): void;
  terminate(): void;
};

type ParallelRuntime = {
  Worker?: new (url: string | URL, options?: { type?: string }) => WorkerLike;
  navigator?: { hardwareConcurrency?: number };
};

export type TileRegionDecoder = (
  bytes: Uint8Array,
  region: ImageRegion,
) => Promise<DecodedLevel>;

function stitch(viewport: ImageRegion, parts: { region: ImageRegion; decoded: DecodedLevel }[]): DecodedLevel {
  const pixels = new Uint8Array(viewport.w * viewport.h * 4);
  for (const { region, decoded } of parts) {
    const dx = region.x - viewport.x;
    const dy = region.y - viewport.y;
    for (let row = 0; row < decoded.height; row++) {
      pixels.set(
        decoded.pixels.subarray(row * decoded.width * 4, (row + 1) * decoded.width * 4),
        ((dy + row) * viewport.w + dx) * 4,
      );
    }
  }
  return { pixels, width: viewport.w, height: viewport.h };
}

type WorkerReply =
  | { id: number; ok: true; pixels: ArrayBuffer; width: number; height: number }
  | { id: number; ok: false; error: string };

let nextWorkerId = 0;

function decodeTileWithWorker(
  worker: WorkerLike,
  bytes: Uint8Array,
  region: ImageRegion,
): Promise<DecodedLevel> {
  const id = ++nextWorkerId;
  return new Promise((resolve, reject) => {
    const onMessage = (ev: { data: WorkerReply }) => {
      if (ev.data.id !== id) return;
      worker.removeEventListener("message", onMessage);
      if (ev.data.ok) {
        resolve({
          pixels: new Uint8Array(ev.data.pixels),
          width: ev.data.width,
          height: ev.data.height,
        });
      } else {
        reject(new Error(ev.data.error));
      }
    };
    worker.addEventListener("message", onMessage);
    // Structured clone copies bytes per worker (no transfer — shared container).
    worker.postMessage({ id, bytes, region });
  });
}

async function decodeTilesParallel(
  containerBytes: Uint8Array,
  tiles: ImageRegion[],
  workerFactory: () => WorkerLike,
): Promise<{ region: ImageRegion; decoded: DecodedLevel }[]> {
  const rt = globalThis as ParallelRuntime;
  const poolSize = Math.min(rt.navigator?.hardwareConcurrency ?? 4, tiles.length);
  const workers = Array.from({ length: poolSize }, workerFactory);
  try {
    const results: { region: ImageRegion; decoded: DecodedLevel }[] = new Array(tiles.length);
    let next = 0;
    await Promise.all(
      workers.map(async (worker) => {
        while (true) {
          const idx = next++;
          if (idx >= tiles.length) break;
          const region = tiles[idx]!;
          const decoded = await decodeTileWithWorker(worker, containerBytes, region);
          results[idx] = { region, decoded };
        }
      }),
    );
    return results;
  } finally {
    for (const w of workers) w.terminate();
  }
}

/**
 * Decode a tiled viewport with optional parallel per-tile workers.
 * Falls back to a single WASM ROI decode when workers unavailable.
 */
export async function decodeTiledViewportPooled(
  containerBytes: Uint8Array,
  region: ImageRegion,
  options?: {
    parallel?: boolean;
    decodeRegion?: TileRegionDecoder;
    workerFactory?: () => WorkerLike;
  },
): Promise<DecodedLevel> {
  const header = parseJxtcHeader(containerBytes);
  const rx = Math.min(Math.max(0, region.x), header.imageW);
  const ry = Math.min(Math.max(0, region.y), header.imageH);
  const rw = Math.min(region.w, header.imageW - rx);
  const rh = Math.min(region.h, header.imageH - ry);
  if (rw <= 0 || rh <= 0) throw new Error("empty tiled viewport");
  const viewport: ImageRegion = { x: rx, y: ry, w: rw, h: rh };

  const decodeRegion = options?.decodeRegion ?? (async (bytes, r) => {
    const out = await decodeTileContainerRegionRgba8(bytes, r);
    return { pixels: out.pixels, width: out.width, height: out.height };
  });

  const tiles = tilesOverlappingRegion(header.imageW, header.imageH, header.tileSize, viewport);
  const wantParallel = options?.parallel !== false
    && canUseParallelTileWorkers()
    && tiles.length > 1
    && options?.workerFactory !== undefined;

  if (!wantParallel) {
    return decodeRegion(containerBytes, viewport);
  }

  const parts = await decodeTilesParallel(containerBytes, tiles, options!.workerFactory!);
  return stitch(viewport, parts);
}