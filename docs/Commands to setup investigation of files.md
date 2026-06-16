Your focus will ONLY be on these files. DO NOT work on any other files other than the ones I specify without asking me first with the exception of the plan and rejection document. I shall be asking you to



1) examine the specified documents through particular "lenses", to scrutinize and examine the code *in your memory* and formulate the proposed issues, improvements and fixes. I want you to run this entirely in plan mode. I want you to work as token-efficiently as possible. 

Then

2. make the fixes evaluating them first as to whether they are a positive improvement and if not reject them with appending a comment to c:\Foo\raw-converter-wasm\docs\rejected optimizations.md with the date-time, target filenames, rejection rationale.

3.  repeat 1 then 2

   Then 

   4.Read in the most important file that touches this file.

   5.Repeat this second file with two rounds of lenses and fixes

   then

   6.with a focus on pipelines/seams/interchanges between them run the lenses again. /7.Implement the fixes. 

   8.Report in a single /docs/XXXX.md file where the combined target filenames are used with a numbered suffix if there is already a matching file and the word ''- DONE'

   9.In this document put an introduction explaining the purpose of the files, the changes made, and chapter three a three paragraph conclusion with 

   a) a conclusion for improvements to file(s) 1.

   b) a conclusion for improvements for file(s) 2. 

   c) improvements to the seams/boundaries between the files

   d) a final concluding few paragraphs.

   e) contribute headline findings to c:\Foo\raw-converter-wasm\docs\Headline Features.md as a news feature that includes date-time, target files and major headline features in a news-like format aimed at the barely-computer-literate layman. Don't worry about pleasantries, unnecessary text or reporting non-issues. Theoretically there should only be tokens burnt on the reading of the two (or 3) files and the writing of the final document.  Thinking is cheap, reading and writing - expensive. Be thorough. Be meticulous. Be exhaustive. Think broadly then think deeply. Consider well and contemplate what you're looking at from different angles and think for the long term. Integrate your existing knowledge. 

   f) Run c:\Foo\raw-converter-wasm\StandardMultifileTest.mjs to ascertain whether there have been any regressions in terms of timings.

   g) Include the final timings of this run versus the previous ten runs in a table with exhaustive metrics. This should be just before the conclusion and have its own conclusion about the timings.

   h) For suspected slowdowns/speedups that you wish to test and where it makes sense to do a targeted flip-flop test: alternate with a switch the same operation ten times with the newer code in place vs the old code or with two or three proposed mechanisms. Write this test code as a .mjs file in c:\Foo\raw-converter-wasm\benchmark\ named after the testing method. Run that file and evaluate it. Write the exhaustive timing output to c:\Foo\raw-converter-wasm\docs\outputs\timing tests\ with a unique descriptive name and date-time.toon. Follow the toon instructions in c:\Foo\raw-converter-wasm\docs\ToonInstructions.md. The output should be based on the following with thermals and cpu reported for each run.

With every lens pass, you will be looking for improvements to 1) efficiency, 2) speed, 3) performance, 4) bugs and 5) existing or opportunities for improved features. 

Lens 1: "a strategic view of each file and how they link and the data they pass between them link".

Lens 2: File
  Public API surface
    exported functions
    WASM bindings
    worker message handlers

Lens 3
  Pipeline stages
    decode
    transform
    resize
    encode
    cache
    return result

Lens 4
  State machinery
    session state
    queue state
    cancellation state
    error state

Lens 5
  Data structures
    buffers
    queues
    manifests
    tile descriptors
    options

Lens 6
  Hot kernels
    pixel loops
    chunk loops
    copy loops
    colour transforms
    resampling

Lens 7
  Boundary points
    JS ↔ WASM
    worker ↔ main thread
    Rust ↔ C/C++
    memory copy points

Lens 8
  Support code
    validation
    logging
    progress
    tests


Lens 9: The Owl lens. An owl is wise. An owl is patient. An owl can see near and far, in night and dark. An owl can turn it's head to see behind it and in front. An owl can hear, see, taste and feel - use your senses to sniff, taste, feel, hear and see your way to improvements.

Lens 10:  Run the film backwards: Old to young, backwards to frontwards; upside-down; back to front; seeing the past with a current view.

Lens 11:  You're a genius computer scientist. Einstein with code. Hawkins in the matrix. What astronomical analogies would assist this code? If we were to examine the stars using phenomenal telescopes, how would that code facilitate that?

Lens 12:  I want you to consider how we can facilitate the use of LLMs, and machine recognition to do recognition quicker, better and more accurately.

Lens 13: What principles can we invoke from gaming?

Lens 14: Photogrammetry is really important to our vision of the use of images in creating digital twins - digital representations of organisms. How can we make the code facilitate this?

Lens 15: Butteraugli is one of the slowest operations in the JXL pipeline. Can we speed this up in these layers?

Lens 16: One of our visions is for the use of immersive technology to be used in Augmented Reality to look at plants, recognise them, identify them in real-time. How can that process be facilitated via these files?

Lens 17: We are integrating a unified, non-Riemannian perceptual color science model derived from the mathematical synthesis of Schrödinger’s geodesic definitions,
 Molchanov's anisotropy measures, the Harvard perception-based color space (HPCS), and Los Alamos's chromatic diminishing returns.

The core of this architecture leverages a sensor-sharpening matrix B and a component-wise log-transform to map Schrödinger's curved, hue-stable geodesics
into a flat, 3D Euclidean coordinate space.

This logarithmic transformation resolves the "Flatness Paradox" of color science, allowing perceptually uniform, illumination-invariant color adjustments to
be computed using fast linear algebra instead of complex differential geodesic equations.

For this upcoming phase, we need to design a highly optimized, SIMD-accelerated, or precomputed multi-dimensional lookup-table (LUT) structure in Rust to
execute these complex logarithmic, exponential, and local spline transformations at sub-millisecond speeds.

So I need you to look if any of that pipeline surfaces in these files and to improve them if they do otherwise ignore this lens.

Lens 18: Knowing the code and what questions have been asked. What are the gaps? If each question shines a light into the code, what are the three larges parts of the house left unilluminated and unexplored?

Lens 19: Repeat this step from a slightly different perspective.

Lens 20: What tricks can you find? One trick involved moving the pointer rather than rereading the memory. Instant speedup from 300ms to 0ms.

Lens 21: Step back with a defocused eye. What feeling do you get when examining the setup of files in their entirety? A birds eye view. What do you see. What stands out. What do you notice about their connectivity. Any last improvements to be made? Home in on these threads.	

---

#Advanced questions:

Lens 22: Where are loops simple scalar code. We can make it much faster with SIMD (process 8–16 pixels at a time using CPU vector instructions; or  Locate tight, data-independent per-element arithmetic loops over u16 (or u8) buffers inside the raw-decode hot path that directly moves the numbers you see in raw_ms / raw_demosaic_ms / raw_decompress_ms in StandardMultifileTest.

Lens 23:  Find places in the raw-decode/encode path where we pay for iterator overhead, repeated indexing, casts, or fresh allocations+copies instead of advancing a pointer/view or mutating in place.

Lens 24: Map every data crossing point in the files you own in memory and ask "is data being duplicated or re-materialized here?"

Lens 25: Where can aspects be coded into C++/Rust for greater speed with a particular focus on handcoded intrinsics.

Lens 26: Where can mathematics be improved for performance and speed improvements

---

