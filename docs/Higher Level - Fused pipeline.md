Absolutely. Here is the handoff inline. I have written it as an engineering brief for Claude CLI: architecture + implementation targets + metrics. It intentionally avoids prescribing every line of code because the goal is for Claude to reshape the codebase rather than just patch kernels.

------

# Butteraugli / JXL Perceptual Pipeline Rewrite Handoff

## Mission

Rewrite the perceptual comparison pipeline into a high-performance imaging subsystem.

Primary goal:

Reduce current Butteraugli-like evaluation cost:

```
~500ms
```

toward:

```
20-50ms realistic target
10-25ms with SIMD + fused WASM path
```

while maintaining:

- visual quality
- score stability
- golden-image compatibility

------

# Core principle

## Remove data movement before optimizing arithmetic

The current pipeline likely does:

```
decode
 |
RGBA buffer
 |
copy
 |
convert
 |
XYB buffers
 |
copy
 |
pyramid
 |
copy
 |
mask
 |
copy
 |
compare
```

The target:

```
compressed input
 |
WASM memory
 |
decode
 |
perceptual transform
 |
pyramid
 |
mask
 |
compare
 |
score
```

Intermediate buffers only exist when they improve cache locality.

------

# Target file structure

Recommended:

```
src/
 |
 +-- perceptual/
 |      |
 |      +-- engine.rs
 |      +-- workspace.rs
 |      +-- pyramid.rs
 |      +-- mask.rs
 |      +-- kernels.rs
 |      +-- simd.rs
 |      +-- metrics.rs
 |
 +-- wasm/
        |
        +-- api.rs
        +-- memory.rs
```

------

# Main object

Create:

```rust
struct PerceptualEngine {

    reference: Option<PerceptualImage>,

    workspace: Workspace,

    metrics: Metrics,

}
```

------

# Cached representation

Reference images should not be cached as raw pixels.

Cache:

```rust
struct PerceptualImage {

    levels: Vec<ScaleLevel>,

}
```

Where:

```rust
struct ScaleLevel {

    width: usize,
    height: usize,

    // perceptual space
    pixels: Vec<Pixel>,

    // precomputed
    inverse_mask: Vec<f32>,
}
```

------

# Pixel representation

Avoid:

```
R plane
G plane
B plane
```

after perceptual transformation.

Use:

```rust
#[repr(C)]
struct Pixel {

    x: f32,
    y: f32,
    b: f32,

}
```

because the comparison becomes:

```rust
dx = a.x - b.x
dy = a.y - b.y
dz = a.b - b.b

error = dx*dx + dy*dy + dz*dz
```

The weighting transform happens once.

------

# Replace weighted distance

Old:

```
kx*dx² + ky*dy² + kb*dz²
```

New:

Pre-transform:

```
X *= sqrt(kx)
Y *= sqrt(ky)
B *= sqrt(kb)
```

Then:

```
distance = dot(delta, delta)
```

Advantages:

- fewer multiplies
- SIMD friendly
- no special-case weights
- easier approximation

------

# Replace nonlinear response

Old:

```
e^(3/2)
```

New:

Approximation:

```
response = e*(a+b*e)
```

with constants tuned against golden corpus.

Alternative:

LUT:

```
response_table[index]
```

Avoid:

- sqrt
- pow
- division

------

# Fused pipeline

Target:

```rust
fn compare(
    reference: &PerceptualImage,
    rgba: &[u8]
)
-> f32
```

Internally:

```
for each tile:

    load RGBA

    convert to perceptual space

    generate scale 0

    generate scale 1

    generate scale 2

    compute masks

    compare against cached reference

    accumulate score
```

------

# Kernel fusion opportunities

## RGB → perceptual → pyramid

Do not:

```
RGB
 |
store
 |
downsample
```

Instead:

```
RGBA tile
 |
convert
 |
immediately emit lower scales
```

A 2×2 block already contains:

```
half resolution pixel
```

Use it immediately.

------

# Downsample rewrite

Replace:

```
dn2(X)
dn2(Y)
dn2(B)
```

with:

```
dn2(Pixel)
```

One loop:

```rust
dst[i].x =
(src[a].x +
 src[b].x +
 src[c].x +
 src[d].x) * 0.25
```

same for y/b.

Benefits:

- one traversal
- better cache
- fewer address calculations

------

# Mask rewrite

Avoid repeated blur passes.

Preferred:

compute:

```
local activity
```

from pyramid generation.

Approx:

```
mask =
constant +
abs(current - local_average)
```

Store:

```
inverse_mask
```

not mask.

Then:

comparison:

```
difference *= inverse_mask
```

No division.

------

# WASM boundary rules

Avoid:

```
JS Uint8Array
 |
Float32Array
 |
copy
 |
WASM
```

Prefer:

```
WASM owns buffers
```

JS passes:

```
pointer
length
metadata
```

------

# Memory rules

Never:

- allocate inside pixel loops
- slice buffers repeatedly
- convert formats repeatedly
- clone image planes

Prefer:

- workspace reuse
- ring buffers
- pointer advancement
- stable ownership

------

# SIMD plan

Implement scalar first.

Then add:

WASM SIMD:

```
v128
f32x4
i8x16
```

Targets:

- RGB transform
- subtract
- square
- accumulation
- downsample

Avoid:

- expensive shuffles
- format conversion
- divisions

------

# Instrumentation

Add a metrics subsystem.

Every run should output:

```
{
 decode_ms,
 transform_ms,
 pyramid_ms,
 mask_ms,
 compare_ms,
 reduction_ms,

 wasm_boundary_ms,

 allocations,
 bytes_copied,

 pixels_processed,

 megapixels_per_second,

 simd_enabled,

 cache_hits,

 cache_misses
}
```

------

# Critical metric

Track:

```
bytes moved / megapixel
```

This is likely the final bottleneck.

A good image pipeline minimizes:

```
touches per pixel
```

------

# Algorithm metrics

Track:

Per-scale contribution:

```
full_scale_score
half_scale_score
quarter_scale_score
```

Track:

```
early_exit_savings
```

Track:

```
optimized_score - original_score
```

------

# Dual implementation mode

Keep:

```
Original
Optimized
```

behind:

```rust
enum AlgorithmMode {

    Reference,

    Optimized,

}
```

Never delete the reference path.

Use it for regression.

------

# Test harness

Create:

```
tests/butteraugli_compare.mjs
```

For each image:

```
run original 10 times

run optimized 10 times

compare:

time
score
delta
memory
```

Output:

```
image
mode
iteration
ms
score
delta
```

------

# Quality gates

Every pixel-changing optimization must pass:

1. Golden images
2. SSIM comparison
3. Butteraugli score delta
4. Visual inspection

Never accept:

```
faster but visually different
```

------

# Sidecar opportunity

At encode time store:

```
.perceptual
```

containing:

- quality score
- multi-scale metrics
- luminance stats
- texture stats
- edge metrics

Then decode quality selection becomes:

```
read metadata
choose effort
decode once
```

instead of:

```
decode
measure
retry
```

------

# Final architectural target

```
                 JS API

                    |

              Session Manager

                    |

              Worker Scheduler

                    |

              WASM Engine

                    |

        +-----------+-----------+

        |                       |

  Decoder kernels        Perceptual kernels

        |                       |

        +-----------+-----------+

                    |

              SIMD primitives

                    |

                output views
```

------

This is the implementation target. The main change is not "make Butteraugli faster"; it is to turn it from a collection of image-processing stages into a **streaming perceptual engine**.
