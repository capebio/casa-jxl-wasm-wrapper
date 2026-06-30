//! perc_scalar_oracle_flip — thermal-cancelled A/B for the four SCALAR perceptual
//! oracles after the BCE / clamp-elision / dead-update pass:
//!   • pixels_to_xyb   (reslice → bounds-check elision)
//!   • scale_err       (reslice → bounds-check elision; FP order untouched)
//!   • dn2_into        (production path: clamp-free chunked 2×2 box reduction)
//!   • box_blur        (drop the dead post-tail rolling update; hoist `edge`)
//!
//! These functions are the bit-reference the SIMD kernels (avx2/avx512/wasm) test
//! against, and they are cold on production (a SIMD backend shadows them). The pass
//! is therefore strictly byte-exact: each case below asserts max|Δ| == 0 ("EXACT").
//! The flip only answers "is NEW a timing regression?" — per the repo rule, a
//! byte-exact NEW that is not slower is kept.
//!
//! A = OLD (pre-pass) · B = NEW (this branch). Interleaved start-rotated rounds,
//! round 0 dropped, median + %saved. Output must read EXACT for every case.
//! Run: cd crates/raw-pipeline && cargo run --release --no-default-features --example perc_scalar_oracle_flip

use std::time::Instant;

// ── deterministic corpora ───────────────────────────────────────────────────────
fn lcg_f32(n: usize, seed: u32) -> Vec<f32> {
    let mut s = seed | 1;
    let mut v = vec![0f32; n];
    for o in v.iter_mut() {
        s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        *o = (s >> 8) as f32 / 16_777_216.0; // [0,1)
    }
    v
}
fn lcg_u8(n: usize, seed: u32) -> Vec<u8> {
    let mut s = seed | 1;
    let mut v = vec![0u8; n];
    for o in v.iter_mut() {
        s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        *o = (s >> 16) as u8;
    }
    v
}

// ═════════════════════════════ pixels_to_xyb ════════════════════════════════════
fn lut() -> [f32; 256] {
    let mut t = [0f32; 256];
    for (i, slot) in t.iter_mut().enumerate() {
        let v = i as f64 / 255.0;
        let lin = if v <= 0.04045 { v / 12.92 } else { ((v + 0.055) / 1.055).powf(2.4) };
        *slot = lin.sqrt() as f32;
    }
    t
}
fn xyb_old(px: &[u8], n: usize, lut: &[f32; 256], x: &mut [f32], y: &mut [f32], b: &mut [f32]) {
    let mut j = 0;
    for i in 0..n {
        let r = lut[px[j] as usize];
        let g = lut[px[j + 1] as usize];
        let bb = lut[px[j + 2] as usize];
        x[i] = (r - bb) * 0.5;
        y[i] = (r + bb) * 0.5 + g;
        b[i] = bb;
        j += 4;
    }
}
fn xyb_new(px: &[u8], n: usize, lut: &[f32; 256], x: &mut [f32], y: &mut [f32], b: &mut [f32]) {
    let px = &px[..n * 4];
    let x = &mut x[..n];
    let y = &mut y[..n];
    let b = &mut b[..n];
    let mut j = 0;
    for i in 0..n {
        let r = lut[px[j] as usize];
        let g = lut[px[j + 1] as usize];
        let bb = lut[px[j + 2] as usize];
        x[i] = (r - bb) * 0.5;
        y[i] = (r + bb) * 0.5 + g;
        b[i] = bb;
        j += 4;
    }
}

// ═══════════════════════════════ scale_err ══════════════════════════════════════
#[allow(clippy::too_many_arguments)]
fn scale_err_old(mask: &[f32], rx: &[f32], ry: &[f32], rb: &[f32], tx: &[f32], ty: &[f32], tb: &[f32], n: usize, kx: f32, ky: f32, kb: f32) -> f32 {
    if n == 0 { return 0.0; }
    let mut sum = 0f64;
    for i in 0..n {
        let m = (mask[i] * 2.0 + 0.15).max(0.15);
        let inv = 1.0 / m;
        let ex = (rx[i] - tx[i]) * inv;
        let ey = (ry[i] - ty[i]) * inv;
        let eb = (rb[i] - tb[i]) * inv;
        let e2 = kx * ex * ex + ky * ey * ey + kb * eb * eb;
        sum += (e2 * (e2 + 1e-12).sqrt()) as f64;
    }
    ((sum / n as f64).cbrt()) as f32
}
#[allow(clippy::too_many_arguments)]
fn scale_err_new(mask: &[f32], rx: &[f32], ry: &[f32], rb: &[f32], tx: &[f32], ty: &[f32], tb: &[f32], n: usize, kx: f32, ky: f32, kb: f32) -> f32 {
    if n == 0 { return 0.0; }
    let mask = &mask[..n];
    let rx = &rx[..n]; let ry = &ry[..n]; let rb = &rb[..n];
    let tx = &tx[..n]; let ty = &ty[..n]; let tb = &tb[..n];
    let mut sum = 0f64;
    for i in 0..n {
        let m = (mask[i] * 2.0 + 0.15).max(0.15);
        let inv = 1.0 / m;
        let ex = (rx[i] - tx[i]) * inv;
        let ey = (ry[i] - ty[i]) * inv;
        let eb = (rb[i] - tb[i]) * inv;
        let e2 = kx * ex * ex + ky * ey * ey + kb * eb * eb;
        sum += (e2 * (e2 + 1e-12).sqrt()) as f64;
    }
    ((sum / n as f64).cbrt()) as f32
}

// ═══════════════════════════════ dn2_into ═══════════════════════════════════════
fn dn2_old(src: &[f32], dst: &mut [f32], w: usize, h: usize, dw: usize, dh: usize) {
    for y in 0..dh {
        let sy0 = y << 1;
        let sy1 = (sy0 + 1).min(h - 1);
        for x in 0..dw {
            let sx0 = x << 1;
            let sx1 = (sx0 + 1).min(w - 1);
            dst[y * dw + x] = (src[sy0 * w + sx0] + src[sy0 * w + sx1] + src[sy1 * w + sx0] + src[sy1 * w + sx1]) * 0.25;
        }
    }
}
fn dn2_new(src: &[f32], dst: &mut [f32], w: usize, h: usize, dw: usize, dh: usize) {
    if w > 1 && h > 1 && dw == w >> 1 && dh == h >> 1 {
        let src = &src[..w * h];
        let dst = &mut dst[..dw * dh];
        for (dst_row, rows) in dst.chunks_exact_mut(dw).zip(src.chunks_exact(w * 2)) {
            let (top, bottom) = rows.split_at(w);
            for ((t, b), o) in top.chunks_exact(2).zip(bottom.chunks_exact(2)).zip(dst_row.iter_mut()) {
                *o = (t[0] + t[1] + b[0] + b[1]) * 0.25;
            }
        }
        return;
    }
    for y in 0..dh {
        let sy0 = y << 1;
        let sy1 = (sy0 + 1).min(h - 1);
        for x in 0..dw {
            let sx0 = x << 1;
            let sx1 = (sx0 + 1).min(w - 1);
            dst[y * dw + x] = (src[sy0 * w + sx0] + src[sy0 * w + sx1] + src[sy1 * w + sx0] + src[sy1 * w + sx1]) * 0.25;
        }
    }
}

// ═══════════════════════════════ box_blur ═══════════════════════════════════════
fn blur_old(src: &[f32], w: usize, h: usize, r: usize) -> Vec<f32> {
    let n = w * h;
    if n == 0 { return Vec::new(); }
    let mut tmp = vec![0f32; n];
    let mut dst = vec![0f32; n];
    let inv = 1.0 / (2 * r + 1) as f32;
    let w_max = w - 1;
    for y in 0..h {
        let base = y * w;
        let mut sum = src[base] * (r as f32 + 1.0);
        for k in 1..=r { sum += src[base + k.min(w_max)]; }
        for x in 0..w {
            tmp[base + x] = sum * inv;
            let add = src[base + (x + r + 1).min(w_max)];
            let sub = src[base + x.saturating_sub(r)];
            sum += add - sub;
        }
    }
    const TILE: usize = 8;
    let h_max = h - 1;
    let mut x = 0usize;
    while x + TILE <= w {
        let mut sums = [0f32; TILE];
        for t in 0..TILE { sums[t] = tmp[x + t] * (r as f32 + 1.0); }
        for k in 1..=r { let row = k.min(h_max) * w; for t in 0..TILE { sums[t] += tmp[row + x + t]; } }
        for y in 0..h {
            let drow = y * w;
            for t in 0..TILE { dst[drow + x + t] = sums[t] * inv; }
            let add_row = (y + r + 1).min(h_max) * w;
            let sub_row = y.saturating_sub(r) * w;
            for t in 0..TILE { sums[t] += tmp[add_row + x + t] - tmp[sub_row + x + t]; }
        }
        x += TILE;
    }
    for col in x..w {
        let mut sum = tmp[col] * (r as f32 + 1.0);
        for k in 1..=r { sum += tmp[k.min(h - 1) * w + col]; }
        for y in 0..h {
            dst[y * w + col] = sum * inv;
            let add = tmp[(y + r + 1).min(h - 1) * w + col];
            let sub = tmp[y.saturating_sub(r) * w + col];
            sum += add - sub;
        }
    }
    dst
}
// NEW: caller-owned scratch + dead-final-update elision + hoisted `edge`.
fn blur_new(src: &[f32], w: usize, h: usize, r: usize, tmp: &mut [f32], dst: &mut [f32]) {
    let n = w * h;
    if n == 0 { return; }
    let src = &src[..n];
    let tmp = &mut tmp[..n];
    let dst = &mut dst[..n];
    let inv = 1.0 / (2 * r + 1) as f32;
    let edge = r as f32 + 1.0;
    let w_max = w - 1;
    for y in 0..h {
        let base = y * w;
        let row = &src[base..base + w];
        let out = &mut tmp[base..base + w];
        let mut sum = row[0] * edge;
        for k in 1..=r { sum += row[k.min(w_max)]; }
        for x in 0..w_max {
            out[x] = sum * inv;
            sum += row[(x + r + 1).min(w_max)] - row[x.saturating_sub(r)];
        }
        out[w_max] = sum * inv;
    }
    const TILE: usize = 8;
    let h_max = h - 1;
    let mut x = 0usize;
    while x + TILE <= w {
        let mut sums = [0f32; TILE];
        for t in 0..TILE { sums[t] = tmp[x + t] * edge; }
        for k in 1..=r { let row = k.min(h_max) * w; for t in 0..TILE { sums[t] += tmp[row + x + t]; } }
        for y in 0..h_max {
            let drow = y * w;
            for t in 0..TILE { dst[drow + x + t] = sums[t] * inv; }
            let add_row = (y + r + 1).min(h_max) * w;
            let sub_row = y.saturating_sub(r) * w;
            for t in 0..TILE { sums[t] += tmp[add_row + x + t] - tmp[sub_row + x + t]; }
        }
        let last = h_max * w;
        for t in 0..TILE { dst[last + x + t] = sums[t] * inv; }
        x += TILE;
    }
    for col in x..w {
        let mut sum = tmp[col] * edge;
        for k in 1..=r { sum += tmp[k.min(h_max) * w + col]; }
        for y in 0..h_max {
            dst[y * w + col] = sum * inv;
            sum += tmp[(y + r + 1).min(h_max) * w + col] - tmp[y.saturating_sub(r) * w + col];
        }
        dst[h_max * w + col] = sum * inv;
    }
}

// ── flip plumbing ────────────────────────────────────────────────────────────────
fn median(v: &[f64]) -> f64 {
    let mut w: Vec<f64> = v[1..].to_vec(); // drop round 0 (cold)
    w.sort_by(|a, b| a.partial_cmp(b).unwrap());
    w[w.len() / 2]
}
fn report(label: &str, ta: &[f64], tb: &[f64], exact: bool) {
    let (ma, mb) = (median(ta), median(tb));
    let saved = (ma - mb) / ma * 100.0;
    let parity = if exact { "EXACT".to_string() } else { "*** DIVERGED ***".to_string() };
    println!("{:>16} | A(old) {:>8.3}ms  B(new) {:>8.3}ms  saved {:>6.1}%  | {}", label, ma, mb, saved, parity);
}
fn max_abs(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b).map(|(x, y)| (x - y).abs()).fold(0.0, f32::max)
}

fn main() {
    println!("perc_scalar_oracle_flip — A=old  B=new (BCE/clamp-elision/dead-update); all must read EXACT\n");
    let rounds = 9;
    let l = lut();

    // ---- pixels_to_xyb (n pixels) ----
    for &(w, h) in &[(1280usize, 800usize), (2560, 1600)] {
        let n = w * h;
        let px = lcg_u8(n * 4, 0xA1);
        let (mut ax, mut ay, mut ab) = (vec![0f32; n], vec![0f32; n], vec![0f32; n]);
        let (mut bx, mut by, mut bb) = (vec![0f32; n], vec![0f32; n], vec![0f32; n]);
        xyb_old(&px, n, &l, &mut ax, &mut ay, &mut ab);
        xyb_new(&px, n, &l, &mut bx, &mut by, &mut bb);
        let exact = max_abs(&ax, &bx) == 0.0 && max_abs(&ay, &by) == 0.0 && max_abs(&ab, &bb) == 0.0;
        let (mut ta, mut tb) = (Vec::new(), Vec::new());
        let mut sink = 0f32;
        for r in 0..rounds {
            let mut da = |s: &mut f32| { let t = Instant::now(); xyb_old(&px, n, &l, &mut ax, &mut ay, &mut ab); *s += ax[n / 2]; t.elapsed().as_secs_f64() * 1e3 };
            let mut db = |s: &mut f32| { let t = Instant::now(); xyb_new(&px, n, &l, &mut bx, &mut by, &mut bb); *s += bx[n / 2]; t.elapsed().as_secs_f64() * 1e3 };
            if r % 2 == 0 { ta.push(da(&mut sink)); tb.push(db(&mut sink)); } else { tb.push(db(&mut sink)); ta.push(da(&mut sink)); }
        }
        std::hint::black_box(sink);
        report(&format!("xyb {w}x{h}"), &ta, &tb, exact);
    }

    // ---- scale_err (7 planes of n) ----
    for &(w, h) in &[(1280usize, 800usize), (2560, 1600)] {
        let n = w * h;
        let (mask, rx, ry, rb) = (lcg_f32(n, 1), lcg_f32(n, 2), lcg_f32(n, 3), lcg_f32(n, 4));
        let (tx, ty, tb_) = (lcg_f32(n, 5), lcg_f32(n, 6), lcg_f32(n, 7));
        let (kx, ky, kb) = (24.0f32, 12.0, 4.0);
        let ea = scale_err_old(&mask, &rx, &ry, &rb, &tx, &ty, &tb_, n, kx, ky, kb);
        let eb = scale_err_new(&mask, &rx, &ry, &rb, &tx, &ty, &tb_, n, kx, ky, kb);
        let exact = ea.to_bits() == eb.to_bits();
        let (mut ta, mut tb) = (Vec::new(), Vec::new());
        let mut sink = 0f32;
        for r in 0..rounds {
            let mut da = |s: &mut f32| { let t = Instant::now(); *s += scale_err_old(&mask, &rx, &ry, &rb, &tx, &ty, &tb_, n, kx, ky, kb); t.elapsed().as_secs_f64() * 1e3 };
            let mut db = |s: &mut f32| { let t = Instant::now(); *s += scale_err_new(&mask, &rx, &ry, &rb, &tx, &ty, &tb_, n, kx, ky, kb); t.elapsed().as_secs_f64() * 1e3 };
            if r % 2 == 0 { ta.push(da(&mut sink)); tb.push(db(&mut sink)); } else { tb.push(db(&mut sink)); ta.push(da(&mut sink)); }
        }
        std::hint::black_box(sink);
        report(&format!("scale_err {w}x{h}"), &ta, &tb, exact);
    }

    // ---- dn2_into (n → n/4) ----
    for &(w, h) in &[(2560usize, 1600usize), (4096, 2560)] {
        let (dw, dh) = (w >> 1, h >> 1);
        let src = lcg_f32(w * h, 11);
        let (mut da_, mut db_) = (vec![0f32; dw * dh], vec![0f32; dw * dh]);
        dn2_old(&src, &mut da_, w, h, dw, dh);
        dn2_new(&src, &mut db_, w, h, dw, dh);
        let exact = max_abs(&da_, &db_) == 0.0;
        let (mut ta, mut tb) = (Vec::new(), Vec::new());
        let mut sink = 0f32;
        for r in 0..rounds {
            let mut fa = |s: &mut f32| { let t = Instant::now(); dn2_old(&src, &mut da_, w, h, dw, dh); *s += da_[0]; t.elapsed().as_secs_f64() * 1e3 };
            let mut fb = |s: &mut f32| { let t = Instant::now(); dn2_new(&src, &mut db_, w, h, dw, dh); *s += db_[0]; t.elapsed().as_secs_f64() * 1e3 };
            if r % 2 == 0 { ta.push(fa(&mut sink)); tb.push(fb(&mut sink)); } else { tb.push(fb(&mut sink)); ta.push(fa(&mut sink)); }
        }
        std::hint::black_box(sink);
        report(&format!("dn2 {w}x{h}"), &ta, &tb, exact);
    }

    // ---- box_blur (n plane, r=w/64 clamped 1..8) ----
    for &(w, h) in &[(1280usize, 800usize), (2560, 1600)] {
        let n = w * h;
        let r = ((w >> 6).max(1)).min(8);
        let src = lcg_f32(n, 21);
        let a = blur_old(&src, w, h, r);
        let (mut btmp, mut b) = (vec![0f32; n], vec![0f32; n]);
        blur_new(&src, w, h, r, &mut btmp, &mut b);
        let exact = max_abs(&a, &b) == 0.0;
        let (mut ta, mut tb) = (Vec::new(), Vec::new());
        let mut sink = 0f32;
        let mut aout = vec![0f32; n];
        for rr in 0..rounds {
            let mut fa = |s: &mut f32| { let t = Instant::now(); aout = blur_old(&src, w, h, r); *s += aout[0]; t.elapsed().as_secs_f64() * 1e3 };
            let mut fb = |s: &mut f32| { let t = Instant::now(); blur_new(&src, w, h, r, &mut btmp, &mut b); *s += b[0]; t.elapsed().as_secs_f64() * 1e3 };
            if rr % 2 == 0 { ta.push(fa(&mut sink)); tb.push(fb(&mut sink)); } else { tb.push(fb(&mut sink)); ta.push(fa(&mut sink)); }
        }
        std::hint::black_box(sink);
        report(&format!("box_blur {w}x{h}"), &ta, &tb, exact);
    }

    println!("\nAll rows must read EXACT (byte-identical). 'saved' >0 = NEW faster; a byte-exact");
    println!("non-regression is kept per repo rule. NB box_blur 'new' also reuses caller scratch");
    println!("(no per-call tmp alloc), part of which this single-buffer flip already reflects.");
}
