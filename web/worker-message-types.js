// Shared message-type identifiers for the RAW per-file worker protocol
// (web/worker.js <-> web/main.js WorkerPool).
//
// These string values are the on-the-wire `type` field of postMessage payloads
// exchanged between the main thread and the per-file RAW worker. They were
// previously bare string literals duplicated on both sides and prone to drift
// (a typo on one side silently drops the message). Centralizing them here makes
// the protocol single-sourced and correct-by-construction: the VALUES are
// unchanged, only the identifiers are now shared.
//
// NOTE: the separate JXL decode worker protocol (decode_jxl / jxl_decoded /
// jxl_progress / decode_error) is intentionally NOT included here — those
// literals do not appear in worker.js and belong to a different boundary.

export const WorkerMsg = Object.freeze({
    // main -> worker (requests)
    RELEASE_STATE:        'release_state',
    REPROCESS_LIVE:       'reprocess_live',
    REPROCESS_THUMB_LIVE: 'reprocess_thumb_live',
    CANCEL:               'cancel',

    // worker -> main (responses / progress)
    THUMB:          'thumb',
    LIGHTBOX:       'lightbox',
    LIGHTBOX_LIVE:  'lightbox_live',
    THUMB_LIVE:     'thumb_live',
    ERROR_LIVE:     'error_live',
    ENCODE_REQUEST: 'encode_request',
    DONE:           'done',
    ERROR:          'error',
});
