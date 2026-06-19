import json

with open('docs/ecosystem-map.model.json') as f:
    m = json.load(f)

new_nodes = [
  # de_opts children
  {
    "id": "do_struct", "k": "component", "p": "de_opts", "l": "DecodeOptions",
    "desc": "Five-field config passed to Decoder::new() or set_options(). parallel (bool, default false, attach JxlThreadParallelRunner), allow_partial (bool, return best partial image from truncated input), keep_orientation (bool, default false, libjxl applies EXIF rotation by default; true gives raw stored orientation), limits (DecodeLimits), cancel (Option<Arc<AtomicBool>>). Default reproduces jxl_lowlevel.rs exactly, the parity contract. Knobs only refuse or observe; they never change the pixels of a decode that succeeds within budget.",
    "tech": ["rust"], "line": 178
  },
  {
    "id": "dl_struct", "k": "component", "p": "de_opts", "l": "DecodeLimits",
    "desc": "Decompression-bomb guard embedded in DecodeOptions.limits. Fields: max_pixels (u64, default 1 000 000 000) and max_output_bytes (u64, default 16 GiB). Checked at BASIC_INFO before any large allocation via checked_mul to prevent size-calculation overflow. Default ceilings generous; real photos never hit them. Hand-written Default impl with specific large constants. Replacing with #[derive(Default)] would zero both and reject every image. Tested by limits_refuse_decompression_bomb.",
    "tech": ["rust"], "line": 159
  },
  {
    "id": "do_cancel", "k": "component", "p": "de_opts", "l": "cancel / is_cancelled",
    "desc": "Cooperative cancellation via Option<Arc<AtomicBool>>. A UI button or timeout sets the flag true; is_cancelled() polls between JxlDecoderProcessInput steps (honest between-steps granularity, cannot interrupt mid-step). Returns DecodeError::Cancelled on first detection. Arc makes the flag shareable; Acquire ordering ensures the cancelling thread stores are visible. Tested by pretripped_cancel_yields_no_image.",
    "tech": ["rust"], "line": 302
  },
  {
    "id": "dm_types", "k": "component", "p": "de_opts", "l": "DecodedMeta / DecodeRegion / DecodeMetrics",
    "desc": "Three bookkeeping types. DecodedMeta (line 98): JxlBasicInfo fields, num_color_channels, has_alpha (alpha_bits > 0), bits_per_sample (source precision, informational), num_extra_channels. DecodeRegion (line 141): x/y/width/height viewport for decode_region; v1 decodes full-then-crop, future JxlDecoderSetCropEnabled v2 lands here without touching callers. DecodeMetrics (line 150): input_bytes, output_bytes, allocations, decode_ms; movement counters for the measurement path.",
    "tech": ["rust"], "line": 97
  },

  # de_event children
  {
    "id": "deevent_enum", "k": "component", "p": "de_event", "l": "DecodeEvent<S>",
    "desc": "Callback message type for decode_progressive (line 202). Two variants: Progress { pass: u32, width, height, pixels: borrowed slice into the live output buffer, zero-copy for the common paint-and-discard path }; Final { width, height, pixels: Vec<S>, owned transfer of the finished image }. Quality is front-loaded so pass 0 carries most visible improvement. Generic S (u8/u16/f16/f32) lets the callback see typed samples without transmute.",
    "tech": ["rust"], "line": 202
  },
  {
    "id": "pc_enum", "k": "component", "p": "de_event", "l": "ProgressControl",
    "desc": "Return type from the decode_progressive callback (line 194): Continue (keep refining) or Stop (bail out, return best-so-far Image). Stop on the very first pass still yields a full-shaped image with correct width/height and full-length pixel buffer. Tested by decode_progressive_stop_returns_best_so_far. Enables gallery-viewer pattern: rough frame appears immediately; if user scrolls away the callback returns Stop and remaining passes are skipped.",
    "tech": ["rust"], "line": 194
  },
  {
    "id": "run_prog_fn", "k": "fn", "p": "de_event", "l": "run_progressive_into",
    "desc": "Private progressive engine (line 642). Subscribes to BASIC_INFO | FRAME_PROGRESSION | FULL_IMAGE, calls JxlDecoderSetProgressiveDetail(kPasses). On S_PROG: calls JxlDecoderFlushImage to materialise partial pixels, fires callback with borrowed Progress event. If callback returns Stop, breaks and returns best-so-far as Image<S>. Progressive flush buffers always zeroed before use (write_bytes), unlike the non-progressive full path, because a flush can expose a buffer libjxl has only partly filled; uninitialised reads would be UB.",
    "tech": ["rust"], "line": 642
  },
  {
    "id": "legacy_prog", "k": "component", "p": "de_event", "l": "ProgressiveFrame / DecodeProgressiveEvent",
    "desc": "Legacy RGBA8-only progressive compat (line 847). ProgressiveFrame: owned struct with width, height, rgba: Vec<u8>, is_final: bool. DecodeProgressiveEvent: borrowed-variant enum for Progress { rgba: &[u8] } and Final { rgba: Vec<u8> }. decode_progressive_frames_borrowed: lends bytes to callback (zero-copy). decode_progressive_frames: clones into owned ProgressiveFrame structs. Retained so existing bench/test call sites do not have to adopt DecodeEvent<S>. Do not use for new code.",
    "tech": ["rust"], "line": 847
  },

  # de_image children
  {
    "id": "img_struct", "k": "component", "p": "de_image", "l": "Image<S>",
    "desc": "Owned decoded image (line 116). Fields: width, height, channels (interleaved count produced: 1/2/3/4), data: Vec<S> (interleaved, len == width*height*channels), extra: Vec<ExtraPlane<S>>, meta: DecodedMeta. channels is the layout requested (ch.count()), not the stream native count; requesting Rgba from an Rgb stream is valid, libjxl fills alpha opaque. Used for display and callers that retain pixels beyond a closure scope.",
    "tech": ["rust"], "line": 116
  },
  {
    "id": "imgview_struct", "k": "component", "p": "de_image", "l": "ImageView<'a, S>",
    "desc": "Borrowed analysis view (line 130). Same fields as Image<S> but as references: data: &'a [S], extra: &'a [ExtraPlane<S>], meta: &'a DecodedMeta. Lives only for the decode_view closure scope, no owned Vec escapes, no copy across a boundary. Ideal for SSIM/Butteraugli/stats (feed the perceptual kernels). Lifetime 'a stops a Vec from escaping: borrow checker guarantees no reference outlives the buffer. Tested by decode_view_matches_owned.",
    "tech": ["rust"], "line": 130
  },
  {
    "id": "channels_enum", "k": "component", "p": "de_image", "l": "Channels",
    "desc": "Four-variant enum naming the interleaved colour layout requested from the decoder (line 77): Gray (1 ch), GrayAlpha (2 ch), Rgb (3 ch), Rgba (4 ch). count() returns the interleaved channel count. Passed to decode/decode_into/decode_view/decode_region as ch. Typed enum rather than bare u32 to make call sites self-documenting and catch wrong values at compile time.",
    "tech": ["rust"], "line": 77
  },
  {
    "id": "extraplane_struct", "k": "component", "p": "de_image", "l": "ExtraPlane<S>",
    "desc": "Planar extra channel read back from the JXL stream (line 108). Fields: index (u32, which extra channel slot), data: Vec<S> (width*height samples, planar). Holds non-colour data: depth maps, thermal readings, spectral bands, separately-stored alpha. Planar layout matches JXL storage and downstream analysis (one channel at a time). Only populated by decode() with want_extra=true; decode_into skips it (per-call allocation defeats zero-allocation goal). decode_region crops extra planes to the same viewport as the colour crop.",
    "tech": ["rust"], "line": 108
  },
  {
    "id": "decoded_meta_struct", "k": "component", "p": "de_image", "l": "DecodedMeta",
    "desc": "Geometry and precision from JxlBasicInfo (line 97), filled at BASIC_INFO before any large allocation. Fields: num_color_channels, has_alpha (alpha_bits > 0), bits_per_sample (source precision, informational; output precision is S), num_extra_channels. Embedded in Image, ImageView, and returned from decode_into. Lets callers know whether to expect an alpha channel and how many extra planes to read, without parsing the header themselves.",
    "tech": ["rust"], "line": 97
  },

  # de_compat children
  {
    "id": "compat_rgba8", "k": "fn", "p": "de_compat", "l": "decode_jxl_rgba8",
    "desc": "Drop-in compat for legacy jxl_lowlevel::decode_jxl_rgba8 (line 794). Returns Option<(Vec<u8>, u32, u32)> as (pixels, width, height). Thin wrapper around decode_interleaved::<u8>(..., 4). Used by bench and test call sites that predate the Decoder object API. Do not use for new code.",
    "tech": ["rust"], "line": 794
  },
  {
    "id": "compat_rgba16", "k": "fn", "p": "de_compat", "l": "decode_jxl_rgba16",
    "desc": "16-bit RGBA compat (line 800). Returns Option<(Vec<u8>, u32, u32)> where bytes are native-endian u16 packed (8 bytes/pixel), matching the prior jpegxl-sys path. Calls decode_interleaved::<u16>(..., 4) then u16_samples_to_ne_bytes for the reinterpret. Helper (line 827) is a safe zero-copy transmute: u16 has no padding/uninit bytes, native-endian in memory, byte view is valid and avoids a second allocation.",
    "tech": ["rust"], "line": 800
  },
  {
    "id": "compat_interleaved", "k": "fn", "p": "de_compat", "l": "decode_interleaved<S>",
    "desc": "Generic interleaved decode free-fn (line 785). Signature: decode_interleaved<S: Sample>(jxl: &[u8], channels: u32) -> Option<(Vec<S>, u32, u32)>. Constructs a single-use Decoder with default options, calls run_raw, returns (pixels, width, height). Backing impl for decode_jxl_rgba8 and decode_jxl_rgba16. Every call creates and destroys a Decoder; fine for one-shot use, wasteful in a loop. Use Decoder directly for repeated decodes.",
    "tech": ["rust"], "line": 785
  },
  {
    "id": "compat_timing", "k": "fn", "p": "de_compat", "l": "decode_full / decode_full_threaded",
    "desc": "Timing-only free-fns (lines 806-824). decode_full: single-threaded wall-time Duration. decode_full_threaded: same with JxlThreadParallelRunner for num_threads > 1. Both route through Decoder::time_full_decode which always requests 4-channel RGBA8; for grayscale JXL this inflates output_bytes 4x and adds channel-upsample cost not present in real usage, but timing is a valid upper bound. Runner setup excluded from timing, matching prior benchmark contract.",
    "tech": ["rust"], "line": 806
  },
  {
    "id": "compat_prog_fn", "k": "fn", "p": "de_compat", "l": "decode_progressive_frames_borrowed",
    "desc": "Legacy progressive free-fn (line 863). Returns Option<(f64, f64)> as (time_to_first_usable_pixel_ms, total_wall_ms). Directly drives a raw JxlDecoder (not the Decoder object) to preserve the legacy shape; subscribes to BASIC_INFO | FRAME_PROGRESSION | FULL_IMAGE, calls JxlDecoderFlushImage on each S_PROG. Sibling decode_progressive_frames clones flush pixels into owned ProgressiveFrame structs. Both exist to shield bench/test call sites from the Decoder/DecodeEvent API change.",
    "tech": ["rust"], "line": 863
  }
]

m['nodes'].extend(new_nodes)
print(f'Added {len(new_nodes)} nodes. Total now: {len(m["nodes"])}')

with open('docs/ecosystem-map.model.json', 'w') as f:
    json.dump(m, f, indent=2, ensure_ascii=False)
print('Written.')
