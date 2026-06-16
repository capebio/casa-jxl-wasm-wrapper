This is the right final handoff format. I’ll make it closer to something an engineer can directly implement: **concrete Rust/WASM-oriented pseudocode, data structures, and kernel sketches**. Where I don’t know your exact existing structs/functions I’ll mark the seam.

The theme: **collapse the pipeline into a small number of streaming kernels.**

------

# Butteraugli Rewrite Handoff — Performance Implementation

## Target

Replace:

```
decode
 → allocate planes
 → RGB→XYB
 → pyramid
 → blur/mask
 → compare
 → reduce
```

with:

```
decode tile
 → perceptual transform
 → pyramid update
 → compare against cached reference
 → accumulate score
```

------

# 1. Core data model

Replace multiple loosely coupled arrays:

```rust
X: Vec<f32>
Y: Vec<f32>
B: Vec<f32>
```

with:

```rust
#[repr(C)]
#[derive(Clone, Copy)]
pub struct PerceptualPixel {
    pub x: f32,
    pub y: f32,
    pub b: f32,
}

pub struct ImageLevel {
    pub width: usize,
    pub height: usize,

    // hot path layout
    pub pixels: Vec<PerceptualPixel>,

    // precomputed
    pub inv_mask: Vec<f32>,
}


pub struct PerceptualImage {
    pub levels: [ImageLevel; 3],
}
```

Reason:

The comparison kernel becomes a streaming vector operation.

------

# 2. Workspace ownership

No allocations inside compare.

```rust
pub struct Workspace {

    // reused every image
    candidate_levels: [ImageLevel;3],

    scratch:
        Vec<PerceptualPixel>,

    metrics:
        Metrics,
}
```

Create once:

```rust
let engine = ButteraugliEngine::new(width,height);
```

Never:

```rust
Vec::new()
```

inside:

```rust
compare()
```

------

# 3. Pre-transform perceptual coordinates

Instead of:

```rust
error =
    kx*dx*dx +
    ky*dy*dy +
    kb*dz*dz;
```

bake weights into conversion.

Old:

```rust
x = (r-b)*0.5
y = (r+b)*0.5+g
b = b
```

New:

```rust
const SX:f32 = 4.89;
const SY:f32 = 3.46;
const SB:f32 = 1.9;


x = ((r-b)*0.5) * SX;
y = ((r+b)*0.5+g) * SY;
b = b * SB;
```

Now:

```rust
distance =
    dx*dx+
    dy*dy+
    db*db;
```

This removes 3 multiplications per pixel.

------

# 4. LUT based RGB transform

Replace:

```rust
linearize(r)
linearize(g)
linearize(b)
```

with:

```rust
static RGB_TABLE:[PerceptualPixel;256];
```

Generated once:

```rust
for i in 0..256 {

    let linear =
        srgb_decode(i);

    RGB_TABLE[i] =
        rgb_to_xyb(linear);
}
```

Hot loop:

```rust
let r = RGB_TABLE[src[0] as usize];
let g = RGB_TABLE[src[1] as usize];
let b = RGB_TABLE[src[2] as usize];
```

No gamma math.

------

# 5. Fused RGBA → pyramid

Do not:

```rust
rgba
 |
xyb buffer
 |
downsample
```

Use:

```rust
fn convert_tile(
    src:&[u8],
    dst:&mut PerceptualImage
)
```

Pseudo:

```rust
for y in 0..height {

    for x in 0..width {

        let p =
            rgba_to_perceptual(src,x,y);

        level0[x,y]=p;


        if even(x,y) {

            let q =
              average_2x2(
                p,
                neighbors
              );

            level1[x/2,y/2]=q;
        }
    }
}
```

One read pass.

------

# 6. Replace dn2()

Old:

```rust
dn2(X)
dn2(Y)
dn2(B)
```

New:

```rust
fn downsample(
    src:&[PerceptualPixel],
    dst:&mut [PerceptualPixel]
)
{
    for i in 0..dst.len(){

        let a=src[idx0];
        let b=src[idx1];
        let c=src[idx2];
        let d=src[idx3];


        dst[i].x =
            (a.x+b.x+c.x+d.x)*0.25;

        dst[i].y =
            (a.y+b.y+c.y+d.y)*0.25;

        dst[i].b =
            (a.b+b.b+c.b+d.b)*0.25;
    }
}
```

------

# 7. Fuse mask generation

Remove:

```rust
blur(Y)
calculate_mask()
invert_mask()
```

Instead:

During pyramid:

```rust
fn compute_mask(
    pixels:&[PerceptualPixel],
    output:&mut [f32]
)
```

Approx:

```rust
activity =
    abs(
       current.y -
       local_mean_y
    );


output[i] =
    1.0 /
    (0.15 + activity);
```

Store inverse directly.

------

# 8. Main compare kernel

This is the new hot loop.

```rust
fn compare_level(
    ref_level:&ImageLevel,
    test_level:&ImageLevel
)
-> f32
{
    let mut total=0.0;


    for i in 0..pixels {


        let dx =
          (ref_level.pixels[i].x -
           test_level.pixels[i].x)
           *
           ref_level.inv_mask[i];


        let dy =
          (ref_level.pixels[i].y -
           test_level.pixels[i].y)
           *
           ref_level.inv_mask[i];


        let db =
          (ref_level.pixels[i].b -
           test_level.pixels[i].b)
           *
           ref_level.inv_mask[i];


        let e =
            dx*dx+
            dy*dy+
            db*db;


        total +=
            fast_response(e);
    }

    total
}
```

------

# 9. Replace nonlinear response

Avoid:

```rust
sqrt(e)*e
```

Use:

```rust
#[inline]
fn fast_response(x:f32)->f32 {

    // tuned against corpus
    x*(0.75+0.25*x)

}
```

or:

```rust
LOOKUP[(x*scale) as usize]
```

------

# 10. Early rejection

Add:

```rust
fn compare()
```

logic:

```rust
let mut score=0;


score += compare_level(full);


if score > threshold {
    return score;
}


score += compare_level(half);


if score > threshold {
    return score;
}


score += compare_level(quarter);
```

For encoder searches this matters enormously.

------

# 11. SIMD target kernels

First candidates:

## Pixel difference

Use:

```
f32x4
```

Process:

```
pixel.x
pixel.y
pixel.b
next pixel.x
```

------

## Downsample

Load:

```
4 pixels
```

average simultaneously.

------

## Reduction

Use vector accumulation:

```rust
let acc =
    acc + error_vector;
```

horizontal reduce at end.

------

# 12. WASM API

Do not expose:

```javascript
compare(
 Float32Array,
 Float32Array
)
```

Expose:

```javascript
compareImage(
 wasmPointer,
 length,
 width,
 height
)
```

The JS side should only:

```javascript
write input
call wasm
read score
```

------

# 13. Metrics instrumentation

Implement:

```rust
struct Metrics {

decode_ns:u64,

rgb_transform_ns:u64,

pyramid_ns:u64,

mask_ns:u64,

compare_ns:u64,

reduce_ns:u64,


bytes_read:u64,

bytes_written:u64,

allocations:u32,


pixels_processed:u64,


simd_active:bool,

early_exit:bool,
}
```

Output:

```json
{
 "time_ms":42,
 "mpix_per_sec":380,
 "bytes_per_pixel":12.4,
 "simd":true,
 "mask_ms":3,
 "compare_ms":18
}
```

------

# 14. Benchmark harness

Three modes:

```rust
enum Mode {

Original,

Optimized,

OptimizedSimd

}
```

Run:

```javascript
for(let i=0;i<10;i++){

 run(original);

 run(optimized);

}
```

Record:

```
image
mode
iteration
time
score
delta
memory
```

------

# 15. Sidecar integration

At encode:

store:

```json
{
 "butteraugli":0.72,

 "scale0":0.31,
 "scale1":0.22,
 "scale2":0.19,

 "texture":0.61,

 "edge_density":0.44
}
```

Decode:

```javascript
if(sidecar.score < target)
{
    skip expensive evaluation;
}
```

------

# Expected outcome

Current:

```
~500ms
```

After algorithm changes:

```
50-100ms
```

After fused pipeline:

```
25-50ms
```

After WASM SIMD + no copies:

```
10-25ms
```

------

