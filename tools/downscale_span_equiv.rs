// Standalone byte-exact equivalence proof for the downscale float-path x-span hoist
// (perf/librs-safe-microops-jun30-v7q9). Pure std — `rustc -O downscale_span_equiv.rs && ./downscale_span_equiv`.
// OLD = pre-edit float box-filter; NEW = x-spans precomputed once per dx. Must be byte-identical.

fn old(src: &[u8], sw: usize, sh: usize, dw: usize, dh: usize) -> Vec<u8> {
    let mut out = vec![0u8; dw * dh * 3];
    let xr = sw as f32 / dw as f32;
    let yr = sh as f32 / dh as f32;
    let mut o = 0usize;
    for dy in 0..dh {
        let y0 = (dy as f32 * yr) as usize;
        let y1 = ((dy as f32 + 1.0) * yr).min(sh as f32) as usize;
        let y1 = y1.max(y0 + 1);
        for dx in 0..dw {
            let x0 = (dx as f32 * xr) as usize;
            let x1 = ((dx as f32 + 1.0) * xr).min(sw as f32) as usize;
            let x1 = x1.max(x0 + 1);
            let x_count = x1 - x0;
            let n = ((y1 - y0) * x_count).max(1) as u32;
            let (mut rr, mut gg, mut bb) = (0u32, 0u32, 0u32);
            let mut row_base = (y0 * sw + x0) * 3;
            for _y in y0..y1 {
                let mut i = row_base;
                for _ in 0..x_count {
                    rr += src[i] as u32;
                    gg += src[i + 1] as u32;
                    bb += src[i + 2] as u32;
                    i += 3;
                }
                row_base += sw * 3;
            }
            out[o] = (rr / n) as u8;
            out[o + 1] = (gg / n) as u8;
            out[o + 2] = (bb / n) as u8;
            o += 3;
        }
    }
    out
}

fn new(src: &[u8], sw: usize, sh: usize, dw: usize, dh: usize) -> Vec<u8> {
    let mut out = vec![0u8; dw * dh * 3];
    let xr = sw as f32 / dw as f32;
    let yr = sh as f32 / dh as f32;
    let x_spans: Vec<(usize, usize)> = (0..dw)
        .map(|dx| {
            let x0 = (dx as f32 * xr) as usize;
            let x1 = ((dx as f32 + 1.0) * xr).min(sw as f32) as usize;
            let x1 = x1.max(x0 + 1);
            (x0, x1 - x0)
        })
        .collect();
    let mut o = 0usize;
    for dy in 0..dh {
        let y0 = (dy as f32 * yr) as usize;
        let y1 = ((dy as f32 + 1.0) * yr).min(sh as f32) as usize;
        let yspan = y1.max(y0 + 1) - y0;
        for &(x0, x_count) in &x_spans {
            let n = (yspan * x_count).max(1) as u32;
            let (mut rr, mut gg, mut bb) = (0u32, 0u32, 0u32);
            let mut row_base = (y0 * sw + x0) * 3;
            for _y in 0..yspan {
                let mut i = row_base;
                for _ in 0..x_count {
                    rr += src[i] as u32;
                    gg += src[i + 1] as u32;
                    bb += src[i + 2] as u32;
                    i += 3;
                }
                row_base += sw * 3;
            }
            out[o] = (rr / n) as u8;
            out[o + 1] = (gg / n) as u8;
            out[o + 2] = (bb / n) as u8;
            o += 3;
        }
    }
    out
}

fn main() {
    // Non-integer ratios that force the float path, incl. real ORF preview sizes.
    let cases = [
        (2592usize, 1944usize, 1800usize, 1350usize), // half-res ORF -> 1800 lightbox
        (2592, 1944, 360, 270),                        // half-res ORF -> 360 thumb
        (5184, 3888, 1800, 1350),                      // full ORF -> lightbox
        (5184, 3888, 360, 270),                        // full ORF -> thumb
        (101, 99, 50, 48),
        (100, 80, 37, 33),
        (640, 427, 200, 133),
        (333, 222, 100, 67),
        (17, 13, 5, 4),
        (3, 2, 2, 1),
    ];
    let mut seed: u64 = 0x9e3779b97f4a7c15;
    let mut next = || {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        (seed >> 24) as u8
    };
    let mut fails = 0usize;
    let mut checked = 0usize;
    for &(sw, sh, dw, dh) in &cases {
        let mut src = vec![0u8; sw * sh * 3];
        for b in src.iter_mut() {
            *b = next();
        }
        let a = old(&src, sw, sh, dw, dh);
        let b = new(&src, sw, sh, dw, dh);
        checked += a.len();
        if a != b {
            fails += 1;
            // find first diff
            let d = a.iter().zip(&b).position(|(x, y)| x != y).unwrap();
            println!("MISMATCH {}x{}->{}x{} at byte {}: old={} new={}", sw, sh, dw, dh, d, a[d], b[d]);
        } else {
            println!("ok {}x{}->{}x{} ({} bytes)", sw, sh, dw, dh, a.len());
        }
    }
    println!("\n{} cases, {} bytes compared, {} fails", cases.len(), checked, fails);
    if fails != 0 {
        std::process::exit(1);
    }
}
