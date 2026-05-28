import type { DecodeSession } from "@casabio/jxl-session";
export type { DecodeSession };
/**
 * Factory function that returns a fresh DecodeSession configured for
 * progressive decode (emitEveryPass: true, progressionTarget: "final").
 * Used by profileJxl and ProgressiveGallery.
 */
export type SessionFactory = () => DecodeSession;
//# sourceMappingURL=types.d.ts.map