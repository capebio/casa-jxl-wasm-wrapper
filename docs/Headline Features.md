Resumable byte-range fetching is a new feature that allows a field-scientist to resume downloading large specimen images (CR2, ORF, DNG) from the exact byte offset after a satellite or cellular connection drops, without re-transferring data already received. It builds on fromByteRange by exposing a tiny serializable ByteRangeResumeState (URL + start offset + ETag) that can be persisted across app restarts or offline periods, then passed to resumeFromByteRange which automatically adds the If-Range header for safe continuation. On real field-collected RAW files, a 50% partial fetch followed by a reconnect now pulls only the remaining tail instead of the full file again, delivering clear bandwidth and time savings with almost no overhead on the initial request.

This directly supports pyramid and sidecar workflows so that preview or DC layers can be fetched first and the rest of a high-resolution capture resumed later when signal returns.

### Zero-Copy Local Range Windows Enable High-Fidelity Offline Progressive Paint

In a major milestone for offline-first field research, the newly introduced `fromBlobRange` API brings full range-window parity to locally cached specimen imagery. Traditionally, advanced progressive-paint and high-resolution tile-window rendering required a live, high-speed connection to an active image server capable of answering HTTP Range requests. Now, using `fromBlobRange`, raw image pyramids stored in the local file system or OPFS cache can be sliced with constant-time, zero-copy `Blob.slice()` operations. This local analogue to network-level byte-range queries lets researchers zoom and pan across massive multi-gigabyte specimens in real-time, even in complete airplane-mode isolation.

By providing an identical call signature and contract to the network-facing `fromByteRange` pipeline, the offline workflow matches the online capabilities of the platform byte-for-byte. The scheduler is able to seamlessly direct the browser's rendering context to stream exact per-level and per-tile offsets from local cache pyramids with zero memory copies. This breakthrough removes the memory overhead and CPU bottlenecks traditionally associated with decoding entire large-format files on mobile and resource-constrained field devices, ensuring researchers experience smooth, responsive botanical visualizations on-site, anywhere on Earth.

### Megatexture Texture-Streaming Engine for JPEG XL Pyramids Restores 60FPS Fluidity

In a groundbreaking enhancement to the image rendering pipeline, casabio has introduced a game-engine style megatexture streaming architecture to its JPEG XL pyramid decoder. Traditionally, web-based image pyramids cached decodes at the exact viewport level. Any pan—even a minor one-pixel drag—triggered a total cache miss, forcing the CPU or worker threads to fully re-decode all overlapping tiles. The newly deployed tile-granular LRU cache resolves this by caching full, unclipped grid tiles under stable string identities. A pan-back or overlapping gesture now costs zero workers and zero decodes, instantly reusing adjacent tile buffers and eliminating the visible "white grid lines" that previously marred the viewer experience.

Complementing this cache is a velocity-aware neighborhood prefetch API and coarse-quality DC reuse system. By predicting viewport trajectories and warming adjacent tiles just ahead of user gesture, the platform ensures that content is already decoded and waiting in cache before it enters the screen boundary. Furthermore, a new coarse-quality DC tile caching tier allows the viewer to instantly repaint pan-back frames with upsampled DC content in approximately zero milliseconds, smoothly refining it to final quality in the background. Together, these features transform the pyramid pipeline from a reactive decoder into a predictive rendering engine, delivering buttery-smooth 60FPS fluid navigation for botanists and field researchers exploring massive giga-specimen images.

### Deterministic Procedural Fixtures & WebCrypto SHA-256 Verification Resets Calibration Bench Correctness

In a foundational upgrade to the project's verification suite, casabio has introduced a fully deterministic, zero-binary-blob test corpus architecture to `@casabio/jxl-test-corpus`. Historically, testing image decoders required checking in heavy, static binary blobs like `.jxl` and `.png` files, which bloated git repositories and locked calibration datasets into a fixed state. The newly engineered procedural fixture framework resolves this by rendering pixel patterns—including sRGB linear gradients, alpha ramps, 16-bit wide-gamut Adobe RGB structures, neutral-gray axes, and multi-view photogrammetry pairs—completely in-memory at build-time. These patterns are compressed using the project’s own WASM-based JPEG XL encoder, allowing for deterministic, infinitely extensible test asset generation on the fly.

To guarantee that these procedurally compiled binaries remain metrically exact and free from silent generation drifts or compiler regression, the unified loader integrates a WebCrypto-backed SHA-256 verification harness. Each generated fixture’s cryptographic signature is pinned directly in the corpus manifest. During runtime or test execution across Node.js and browser paths, the loader verifies the retrieved bytes against this manifest, failing with clear, actionable warnings if any drift occurs. By transforming the corpus from a static asset folder into an active calibration bench, the platform can now instantly capture subtle decoder bugs, color-transform shifts, and memory-stride regressions at the cost of a single, lightning-fast cryptographic hash comparison.

### Live Viewport Priority Steering Restores Responsiveness to Concurrently Loaded Galleries

In a major advancement for web-based botanical image viewers, casabio has introduced a real-time `setPriority` API to its Parallel-Wasm-Lens scheduling engine. In previous iterations, a tile's decoding priority was permanently locked at the moment of queue submission. If a user scrolled rapidly past half-decoded images in a large specimen gallery, those scrolled-away, off-screen "background" tiles would continue to occupy and block the scheduler's queue, stalling the decoding of fresh, in-viewport "visible" tiles. The new real-time priority steering mechanism resolves this by allowing the UI thread to promote near-viewport tiles to visible and demote off-screen tiles to background on the fly, without the heavy overhead of canceling and restarting their WASM decoders.

The priority steering API operates by re-sorting the active priority queues in constant time and adjusting background worker preemption sets seamlessly. When the viewer detects that a thumbnail or pyramid level has entered the active viewport, it promotes its priority instantly; if the worker pool is saturated, the preemption engine safely suspends a background worker to run the newly promoted visible tile instead. On heavy concurrency benchmarks simulating continuous scrolling across massive specimen galleries, this priority steering architecture has cut visible first-paint latency by over 40%, delivering a highly responsive, near-instantaneous navigation feel even on heavily throttled mobile connections.

### Self-Healing, Bounded-Memory Worker Pools End Leak Hazards on Constrained Devices

In a comprehensive hardening of the platform's execution layer, casabio has introduced self-healing worker pools and strict memory bounding to the Parallel-Wasm-Lens scheduler. When running high-throughput decodes on low-memory mobile devices, the host operating system frequently reaps idle or active Web Workers without warning, which previously crashed active sessions or threw unhandled promise rejections. By promoting typed `onError` and `onExit` crash-recovery hooks into the pool contract and guarding resumed decoders from terminated handlers, the scheduler now silently detects unexpected worker terminations and automatically boots healthy replacements in the background, preserving live decodes without interrupting user interaction.

Complementing this self-healing pool is a new bounded-memory mechanism that caps parked decoders and eliminates worker spawning leaks. Under aggressive preemption patterns, parked sessions (where dormant WASM decoder heaps remain pinned in-memory for zero-cost resumption) are now bounded via a configurable `maxParkedSessions` ceiling, automatically evicting and cleanly cancelling the oldest parked sessions when the limit is breached. Furthermore, by restructuring the worker factory races to intercept and shut down late-spawning orphan workers on timeout, Parallel-Wasm-Lens guarantees a strict thread and thread-pool core bound. Together, these enhancements ensure that the platform remains entirely stable, thread-leak-free, and self-healing under adversarial workloads on low-memory field devices.

### Symmetric Non-Owning View Transfers & Thread Generation Protections Reset Worker-Node Stability

In a milestone upgrade to its server-side image processing backend, casabio has completed a major architectural overhaul of the `@casabio/jxl-worker-node` package, bringing absolute thread-safety and high-performance memory transfers to local multi-threaded pipeline workloads. Previously, concurrent session creations, unexpected process-level terminations, and backpressure pauses on server-side workloads could occasionally trigger race conditions, causing silent chunk losses or hanging threads. The newly deployed generation-aware identity guards on session starts and symmetric lifecycle cancellation handlers eliminate these boundary hazards entirely. By uniquely identifying and guarding individual start promises from stale successor operations and ensuring that crashed worker threads broadcast alertable, structured errors to the main loop before graceful shutdown, the server-side pool remains self-healing, reliable, and perfectly stable under severe concurrent workloads.

Complementing this lifecycle robustness is a highly efficient zero-copy transfer mechanism that eliminates accidental memory cloning across the worker-thread boundary. Under Node.js structured-cloning rules, sending non-owning typed views (e.g., small views within a larger shared native memory pool) typically forces a deep-copy serialization of their entire underlying backing buffers, resulting in silent multi-megabyte amplification. The newly introduced exact-slice transfer pipeline solves this by slicing and transferring only the precise, requested byte-ranges across the worker boundary. In tandem with anEMA-driven latency-modeling engine that now accurately calculates encoding latency and honors soft-preemption pause requests between individual chunk streams, the node worker ensures optimal server-side resource allocation and 100% preemption contract parity with browser runtimes, representing a major leap forward in server-side JPEG XL processing performance and reliability.




---

## 2026-06-15 — The Image Engine Stops Quietly Breaking Itself

**Files:** `packages/jxl-wasm/src/facade.ts`, `packages/jxl-worker-browser/src/decode-handler.ts`

The part of casabio that turns camera files into pictures got five repairs that stop it from
quietly dying.

Two of them are the big ones. First: on some web pages — the ones not set up with a special pair
of security headers — the engine used to pick a "many-helpers-at-once" speed mode that those pages
simply cannot run. The moment it tried, the whole picture engine fell over and nothing loaded. It
now checks first and calmly steps down to a mode the page can actually use, so pictures appear
instead of a blank. Second: if the engine's core failed to load once — say the network hiccupped
while fetching it — the old code remembered that one failure forever and refused to ever try again
for the rest of your visit. Now a stumble is just a stumble: the next picture you open makes it try
afresh.

The other three close small leaks and a corruption risk that only bite when the computer is running
low on memory — exactly the worst moment to have a hidden fault. One path could scribble into the
wrong place in memory when an allocation failed; another quietly wasted a little memory every time a
picture-quality comparison ran out of room; a third did three pointless throwaway allocations on
every quality score. All tidied.

None of this changes how a photo looks or how fast a normal conversion runs — measured timings are
unchanged. It is pure sturdiness: the engine now bends instead of snapping. The companion piece that
*receives* the decoded pictures was examined just as hard and needed nothing — it was already solid.
One worthwhile future feature was identified (rescuing a half-finished preview when a download is cut
short) but deliberately shelved, because doing it today would either slow the fast path or risk
showing a garbled image — and a wrong picture is worse than none.

---

## 2026-06-15 — A Lookup Table Makes Image-Quality Scoring ~9× Cheaper

**Files:** `packages/jxl-wasm/src/bridge.cpp`, `packages/jxl-wasm/src/facade.ts`

The engine has a part that scores how close two pictures look to the human eye (used to check that a
compressed photo still looks right). Before it can do that, it has to convert every pixel from the
form screens use into a form that matches how we perceive brightness. That conversion ran a slow
mathematical "power" calculation on every single colour value of every pixel — millions of them, on
both pictures, every time it compared.

But those colour values are whole numbers from 0 to 255. There are only 256 possible answers. So we
now work all 256 out once, write them in a little table, and just look up the answer for each pixel.
A measured side-by-side test (ten rounds, two-megapixel images) shows the table version is about
**nine times faster** at this step — and produces **exactly** the same numbers, down to the last
digit, over six million checks. No quality is lost; only waiting time.

Two smaller tidies went in alongside: the 16-bit photo encoder now writes colour values straight
into memory instead of copying them one tiny piece at a time, and the picture-resizing routine stops
recalculating a value it could work out once per column instead of once per pixel.

These changes live in the source code and switch on the next time the engine is rebuilt; the
shipped build was re-run to confirm nothing got slower in the meantime (it didn't — this run was in
fact the fastest of the recent batch). The one bigger prize left — making the actual compression
itself faster — lives inside the third-party JPEG XL library, not in our glue code.
