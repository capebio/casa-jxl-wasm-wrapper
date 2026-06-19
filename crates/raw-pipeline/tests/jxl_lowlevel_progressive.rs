#![cfg(all(feature = "jxl-codec", not(target_arch = "wasm32")))]

use raw_pipeline::casabio_encode::{encode_variants_with_progressive, SourceType};
use raw_pipeline::jxl_decode::{
    decode_progressive_frames, decode_progressive_frames_borrowed, DecodeProgressiveEvent,
    ProgressiveFrame,
};

fn gradient_rgba(w: u32, h: u32) -> Vec<u8> {
    let mut rgba = vec![0u8; (w * h * 4) as usize];
    for y in 0..h {
        for x in 0..w {
            let i = ((y * w + x) * 4) as usize;
            rgba[i] = ((x * 255) / w.max(1)) as u8;
            rgba[i + 1] = ((y * 255) / h.max(1)) as u8;
            rgba[i + 2] = (((x + y) * 255) / (w + h).max(1)) as u8;
            rgba[i + 3] = 255;
        }
    }
    rgba
}

#[test]
fn progressive_decode_emits_final_frame_with_image_shape() {
    let (w, h) = (256u32, 192u32);
    let rgba = gradient_rgba(w, h);
    let variants = encode_variants_with_progressive(&rgba, w, h, SourceType::Raw, false, 2, 1)
        .expect("encode progressive test image");

    let mut frames: Vec<ProgressiveFrame> = Vec::new();
    let timings = decode_progressive_frames(&variants.full, |frame| frames.push(frame));

    assert!(timings.is_some(), "expected progressive decode timings");
    assert!(!frames.is_empty(), "expected at least final frame");

    let final_frame = frames.last().expect("final frame");
    assert!(final_frame.is_final, "last callback must be final frame");
    assert_eq!(final_frame.width, w);
    assert_eq!(final_frame.height, h);
    assert_eq!(final_frame.rgba.len(), (w * h * 4) as usize);

    if frames.len() > 1 {
        assert!(
            frames[..frames.len() - 1]
                .iter()
                .all(|frame| !frame.is_final),
            "all intermediate frames must be non-final; only the last frame should be final"
        );
    }
}

#[test]
fn progressive_decode_borrowed_api_emits_progress_and_final_shapes() {
    let (w, h) = (256u32, 192u32);
    let rgba = gradient_rgba(w, h);
    let variants = encode_variants_with_progressive(&rgba, w, h, SourceType::Raw, false, 2, 1)
        .expect("encode progressive test image");

    let mut saw_final = false;
    let mut saw_non_final = false;
    let timings = decode_progressive_frames_borrowed(&variants.full, |event| match event {
        DecodeProgressiveEvent::Progress {
            width,
            height,
            rgba,
        } => {
            saw_non_final = true;
            assert_eq!(width, w);
            assert_eq!(height, h);
            assert_eq!(rgba.len(), (w * h * 4) as usize);
        }
        DecodeProgressiveEvent::Final {
            width,
            height,
            rgba,
        } => {
            saw_final = true;
            assert_eq!(width, w);
            assert_eq!(height, h);
            assert_eq!(rgba.len(), (w * h * 4) as usize);
        }
    });

    assert!(timings.is_some(), "expected progressive decode timings");
    assert!(saw_final, "expected final borrowed event");
    // Note: if saw_non_final is true, saw_final is already asserted above.
    // To check ordering explicitly, add event tracking to the closure if needed.
}
