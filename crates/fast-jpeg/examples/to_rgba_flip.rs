//! to_rgba_flip — thermal-cancelled A/B/C for fast-jpeg `to_rgba`.
//!
//! `to_rgba` runs once per JPEG decode, expanding the decoder's interleaved
//! RGB24 (or L8) output into RGBA8 for the canvas. It is the only hand-written
//! compute loop in the crate (the DCT decode itself lives in `jpeg_decoder`).
//!
//! RGB24 variants (the dominant colour-JPEG case):
//!   A = current:  Vec::with_capacity; per pixel extend_from_slice(3) + push(255)
//!   B = prefill:  vec![255; n*4]; zip chunks_exact_mut(4)/chunks_exact(3), copy 3
//!   C = unsafe:   with_capacity + set_len; raw ptr writes, 4 bytes/pixel
//!
//! A pays a length bump + capacity check on every push/extend. B memsets alpha
//! once (vectorized) then copies 3-byte runs into a fixed-size buffer — no length
//! bookkeeping. C drops bounds checks entirely. Parity asserted byte-exact.
//!
//! Interleaved, start-rotated each round; round 0 (cold) dropped from the median.
//!
//! Run: cd crates/fast-jpeg && cargo run --release --example to_rgba_flip

use std::time::Instant;

// ---- RGB24 → RGBA ----------------------------------------------------------

fn rgb_a(pixels: &[u8]) -> Vec<u8> {
    let mut rgba = Vec::with_capacity((pixels.len() / 3) * 4);
    for chunk in pixels.chunks_exact(3) {
        rgba.extend_from_slice(chunk);
        rgba.push(255);
    }
    rgba
}

fn rgb_b(pixels: &[u8]) -> Vec<u8> {
    let npix = pixels.len() / 3;
    let mut rgba = vec![255u8; npix * 4];
    for (dst, src) in rgba.chunks_exact_mut(4).zip(pixels.chunks_exact(3)) {
        dst[..3].copy_from_slice(src);
    }
    rgba
}

fn rgb_c(pixels: &[u8]) -> Vec<u8> {
    let npix = pixels.len() / 3;
    let mut rgba: Vec<u8> = Vec::with_capacity(npix * 4);
    unsafe {
        rgba.set_len(npix * 4);
        let mut s = pixels.as_ptr();
        let mut d = rgba.as_mut_ptr();
        for _ in 0..npix {
            *d = *s;
            *d.add(1) = *s.add(1);
            *d.add(2) = *s.add(2);
            *d.add(3) = 255;
            s = s.add(3);
            d = d.add(4);
        }
    }
    rgba
}

// ---- L8 → RGBA -------------------------------------------------------------

fn l8_a(pixels: &[u8]) -> Vec<u8> {
    let mut rgba = Vec::with_capacity(pixels.len() * 4);
    for &lum in pixels {
        rgba.extend_from_slice(&[lum, lum, lum, 255]);
    }
    rgba
}

fn l8_b(pixels: &[u8]) -> Vec<u8> {
    let mut rgba = vec![255u8; pixels.len() * 4];
    for (dst, &lum) in rgba.chunks_exact_mut(4).zip(pixels) {
        dst[0] = lum;
        dst[1] = lum;
        dst[2] = lum;
    }
    rgba
}

// ---- harness ---------------------------------------------------------------

fn median(v: &[f64]) -> f64 {
    let mut w: Vec<f64> = v[1..].to_vec(); // drop round 0 (cold)
    w.sort_by(|a, b| a.partial_cmp(b).unwrap());
    w[w.len() / 2]
}

fn flip3(
    label: &str,
    input: &[u8],
    fa: &dyn Fn(&[u8]) -> Vec<u8>,
    fb: &dyn Fn(&[u8]) -> Vec<u8>,
    fc: Option<&dyn Fn(&[u8]) -> Vec<u8>>,
) {
    let ref_out = fa(input);
    assert_eq!(fb(input), ref_out, "{label}: B parity broken");
    if let Some(fc) = fc {
        assert_eq!(fc(input), ref_out, "{label}: C parity broken");
    }

    let rounds = 11usize;
    let (mut ta, mut tb, mut tc) = (Vec::new(), Vec::new(), Vec::new());
    let mut sink = 0u64;
    let time = |f: &dyn Fn(&[u8]) -> Vec<u8>, sink: &mut u64| {
        let t = Instant::now();
        let out = f(input);
        let ms = t.elapsed().as_secs_f64() * 1e3;
        *sink = sink.wrapping_add(out.len() as u64 + out[out.len() / 2] as u64);
        std::hint::black_box(&out);
        ms
    };
    for r in 0..rounds {
        // start-rotate ordering each round to cancel drift
        match r % 3 {
            0 => {
                ta.push(time(fa, &mut sink));
                tb.push(time(fb, &mut sink));
                if let Some(fc) = fc { tc.push(time(fc, &mut sink)); }
            }
            1 => {
                tb.push(time(fb, &mut sink));
                if let Some(fc) = fc { tc.push(time(fc, &mut sink)); }
                ta.push(time(fa, &mut sink));
            }
            _ => {
                if let Some(fc) = fc { tc.push(time(fc, &mut sink)); }
                ta.push(time(fa, &mut sink));
                tb.push(time(fb, &mut sink));
            }
        }
    }
    std::hint::black_box(sink);

    let ma = median(&ta);
    let mb = median(&tb);
    let sb = (ma - mb) / ma * 100.0;
    if fc.is_some() {
        let mc = median(&tc);
        let sc = (ma - mc) / ma * 100.0;
        println!(
            "{:>20} | A {:>8.4}ms  B {:>8.4}ms ({:>5.1}%)  C {:>8.4}ms ({:>5.1}%)",
            label, ma, mb, sb, mc, sc
        );
    } else {
        println!(
            "{:>20} | A {:>8.4}ms  B {:>8.4}ms ({:>5.1}%)",
            label, ma, mb, sb
        );
    }
}

fn main() {
    // Representative decoded sizes after DCT-domain downscale (denom 1/2).
    // 12 MP (4000×3000) full and 3 MP (2000×1500) half are the common gallery cases.
    let sizes = [(2000usize, 1500usize, "3MP"), (4000, 3000, "12MP"), (6000, 4000, "24MP")];

    println!("to_rgba flip — RGB24→RGBA  A=extend+push  B=prefill255+copy  C=unsafe ptr\n");
    for (w, h, tag) in sizes {
        let n = w * h;
        // deterministic non-trivial content
        let rgb: Vec<u8> = (0..n * 3).map(|i| (i * 31 + 7) as u8).collect();
        flip3(&format!("RGB24 {tag}"), &rgb, &rgb_a, &rgb_b, Some(&rgb_c));
    }

    println!("\nto_rgba flip — L8→RGBA  A=extend  B=prefill255+write3\n");
    for (w, h, tag) in sizes {
        let n = w * h;
        let l8: Vec<u8> = (0..n).map(|i| (i * 17 + 3) as u8).collect();
        flip3(&format!("L8 {tag}"), &l8, &l8_a, &l8_b, None);
    }

    println!("\nGate: keep a variant only if ≥5% on the 12MP/24MP rows with byte-exact parity.");
}
