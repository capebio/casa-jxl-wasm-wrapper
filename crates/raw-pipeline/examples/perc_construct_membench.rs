//! Counting-allocator membench for `perceptual::Comparer::new` (PERC-12).
//!
//! Measures PEAK transient heap above baseline during construction — the metric
//! that captures the level-0 clone elimination (clone→move+borrow). Peak bytes
//! are deterministic (thermal-independent), so an A/B across builds (base = clone,
//! branch = move) is rigorous without interleaving.
//!
//! Run:  cargo run --release --no-default-features --example perc_construct_membench
//!
//! Reports, per size: peak_transient_MB, resident_after_MB, alloc_count, median_ms.

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering::Relaxed};
use std::time::Instant;

use raw_pipeline::perceptual::{Comparer, Opts};

struct Counting;
static CURRENT: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);
static COUNT: AtomicUsize = AtomicUsize::new(0);

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        let p = System.alloc(l);
        if !p.is_null() {
            let cur = CURRENT.fetch_add(l.size(), Relaxed) + l.size();
            COUNT.fetch_add(1, Relaxed);
            let mut pk = PEAK.load(Relaxed);
            while cur > pk {
                match PEAK.compare_exchange_weak(pk, cur, Relaxed, Relaxed) {
                    Ok(_) => break,
                    Err(x) => pk = x,
                }
            }
        }
        p
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        CURRENT.fetch_sub(l.size(), Relaxed);
        System.dealloc(p, l);
    }
}

#[global_allocator]
static A: Counting = Counting;

const MB: f64 = 1024.0 * 1024.0;

fn measure(size: usize, reps: usize) -> (f64, f64, usize, f64) {
    let n = size * size;
    // Allocate input OUTSIDE the measurement window (it is part of baseline, not the win).
    let rgba = vec![128u8; n * 4];
    let mut peaks = Vec::new();
    let mut residents = Vec::new();
    let mut counts = Vec::new();
    let mut times = Vec::new();
    for _ in 0..reps {
        let base = CURRENT.load(Relaxed);
        PEAK.store(base, Relaxed);
        COUNT.store(0, Relaxed);
        let t = Instant::now();
        let c = Comparer::new(&rgba, size, size, Opts::default());
        let ms = t.elapsed().as_secs_f64() * 1000.0;
        let peak = PEAK.load(Relaxed).saturating_sub(base);
        let resident = CURRENT.load(Relaxed).saturating_sub(base);
        let cnt = COUNT.load(Relaxed);
        std::hint::black_box(&c);
        drop(c);
        peaks.push(peak as f64 / MB);
        residents.push(resident as f64 / MB);
        counts.push(cnt);
        times.push(ms);
    }
    let median = |v: &mut Vec<f64>| {
        v.sort_by(|a, b| a.partial_cmp(b).unwrap());
        v[v.len() / 2]
    };
    (
        median(&mut peaks),
        median(&mut residents),
        counts[counts.len() / 2],
        median(&mut times),
    )
}

fn main() {
    // warm
    let _ = measure(256, 2);
    println!("size\tpeak_transient_MB\tresident_MB\talloc_count\tmedian_ms");
    for &size in &[1024usize, 2048, 4096] {
        let (peak, resident, count, ms) = measure(size, 7);
        println!(
            "{0}x{0}\t{1:.1}\t{2:.1}\t{3}\t{4:.2}",
            size, peak, resident, count, ms
        );
    }
}
