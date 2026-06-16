Your focus will ONLY be on these files. DO NOT work on any other files than the ones I specify without asking me first. I shall be asking you to examine the documents through particular "lenses" and to scrutinize   and examine the code *in your memory*, formulate the proposed issues, improvements and fixes. I want you to work as token-efficiently as possible, only handing back the concise issue and fixes. Don't worry about pleasantries, unneccesary text or reporting non-issues. Theoretically there should only be tokens burnt on the reading of the two files and the writing of the final document and final comments.  Thinking is cheap, reading and writing - expensive. 

  With every lens pass, you will be
  looking for improvements to 1) efficiency, 2) speed, 3) performance, 4) bugs and 5) existing or opportunities for proposed features. Be thorough. Be meticulous. Be exhaustive. Think broadly then think deeply. Consider well and contemplate what you're looking at from different angles and think for the long term. Integrate your existing knowledge. 

  At the very end, create a cohesive document with duplicate items amalgamated that provides handoffs to five Grok agents to implement. There can be more than 5 sessions. Each agent should only handle one file. This should include suggested code snippets where there is anything ambiguous. That markdown should be made up of a name that incorporates the files that are assessed. Each handoff section should begin with the phrase: "If you agree that the contribution is positive in the context of the pipeline, implement it, otherwise reject it with your reasons in C:\Foo\raw-converter-wasm\docs\rejected optimizations.md"


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

Lens 10: Lens 14 — run the film backwards. 4 findings, each from a reversal:

Lens 11:  You're a genius computer scientist. Einstein with code. Hawkins in the matrix. What astronomical analogies would assist this code? If we were to examine the stars using phenomenal telescopes, how would that code facilitate that?

Lens 12:  I want you to consider how we can facilitate the use of LLMs, and machine recognition to do recognition quicker, better and more accurately.

Lens 13: What principles can we invoke from gaming?

Lens 14: Photogrammetry is really important to our vision of the use of images in creating digital twins - digital representations of organisms. How can we make the code facilitate this?

Lens 15: Butteraugli is one of the slowest operations in the JXL pipeline. Can we speed this up in these layers?

Lens 16: One of our visions is for the use of immersive technology to be used in Augmented Reality to look at plants, recognise them, identify them in real-time. How can that process be facilitated via these files?

Lens 17: 1. We are integrating a unified, non-Riemannian perceptual color science model derived from the mathematical synthesis of Schrödinger’s geodesic definitions,
      Molchanov's anisotropy measures, the Harvard perception-based color space (HPCS), and Los Alamos's chromatic diminishing returns.
   2. The core of this architecture leverages a sensor-sharpening matrix B and a component-wise log-transform to map Schrödinger's curved, hue-stable geodesics
      into a flat, 3D Euclidean coordinate space.
   3. This logarithmic transformation resolves the "Flatness Paradox" of color science, allowing perceptually uniform, illumination-invariant color adjustments to
      be computed using fast linear algebra instead of complex differential geodesic equations.
   4. To handle local defects where the flat model diverges from human vision, we incorporate Molchanov’s parallelogram law residuals to adaptively discretize our
      precomputed metric tensor grid, concentrating density around the neutral gray axis and saturated greens.
   5. Furthermore, we modulate local slider sensitivities and edge-detection thresholds using Molchanov’s distance structure tensor Aₜₑₙₛₒᵣ to guarantee perfectly
      uniform, linear visual changes across all hues.
   6. To prevent mathematical coordinate drift near grays, we apply a hybrid correction that blends the Riemannian geodesic steps with direct non-Riemannian Δ
      E₂₀₀₀ corrections, functioning as a stabilizing "spring force" pulling coordinates onto the true neutral point.
   7. Finally, we refine our flat coordinate space using Los Alamos's non-uniform, localized chromatic diminishing returns curves f(c) to calibrate the exact rate
      of perceptual compression for pinks, greens, oranges, and blues.
   8. We intend to implement this entire multi-layered color engine directly in our Rust/WASM-resident LookRenderer pipeline (crates/raw-pipeline/src/pipeline.rs)
      under the hot per-pixel apply_tone_math loop.
   9. This Rust engine will expose a high-performance "Perceptual Constancy Mode" to our JavaScript lightbox, allowing illumination-invariant exposure, saturation,
      and white-balance adjustments during progressive JXL paints.
   10. For the upcoming phase, we need to design a highly optimized, SIMD-accelerated, or precomputed multi-dimensional lookup-table (LUT) structure in Rust to
       execute these complex logarithmic, exponential, and local spline transformations at sub-millisecond speeds.
	

Lens 18: Knowing the code and what questions have been asked. What are the gaps? If each question shines a light into the code, what are the three larges parts of the house left unilluminated and unexplored?

Lens 19: Step back with a defocused eye. Cast a feeling eye over the whole setup. A birds eye view. What do you see. What stands out. What do you notice about their connectivity. Any last improvements to be made?	   

Provide a two or three paragaph overview of what would be achieved by implementing these suggestions at the end.

 I want you to review and organise this large and piecemeal document into sensible chunks. Each chapter will be an implementation layer focused on related
   things such that a suitably skilled worker can implement it. 

At the very, tell the last agent to append - DONE to the filename. 
