#[cfg(feature = "jxl-encode")]
pub mod casabio_encode;
#[cfg(feature = "jxl-lowlevel")]
pub mod jxl_lowlevel;
pub mod cr2;
pub mod decompress;
pub mod demosaic;
pub mod dng;
pub mod exif;
pub mod ljpeg;
pub mod pipeline;
pub mod tiff;
pub mod perceptual;
pub mod tone_simd;

// Re-export the stable B4 metadata-only public API for convenience
pub use tiff::{parse_orf_metadata, bench_decode_orf, OrfMetadata, DecodeBench};
pub use pipeline::apply_perceptual_constancy;  // Layer 5: exposed for post-JXL / progressive pixel constancy (ties to benchmark postDecodeTransform + Cursor for early layers). Positive for vision use cases.

#[cfg(test)]
mod compile_tests {
    use super::*;

    #[test]
    fn pipeline_params_default_builds() {
        let p = pipeline::PipelineParams::default_olympus();
        assert_eq!(p.black, 256);
        assert_eq!(p.white, 4095);
    }

    #[test]
    fn process_synthetic_black_frame() {
        let w = 4usize;
        let h = 4usize;
        let raw = vec![256u16; w * h];
        let rgb16 = demosaic::demosaic_rggb(&raw, w, h).unwrap();
        let params = pipeline::PipelineParams::default_olympus();
        let rgb8 = pipeline::process(&rgb16, &params);
        assert!(rgb8.iter().all(|&v| v < 50),
            "expected near-black output, got max={}", rgb8.iter().max().unwrap());
    }

    #[test]
    fn process_synthetic_white_frame_does_not_panic() {
        let rgb16 = vec![4095u16; 4 * 4 * 3];
        let params = pipeline::PipelineParams::default_olympus();

        let rgb8 = pipeline::process(&rgb16, &params);

        assert_eq!(rgb8.len(), rgb16.len());
        assert!(rgb8.iter().any(|&v| v > 200));
    }

    #[test]
    fn process_rgba_produces_4ch_and_alpha_255() {
        let rgb16 = vec![4095u16; 2 * 2 * 3];
        let params = pipeline::PipelineParams::default_olympus();

        let rgba = pipeline::process_rgba(&rgb16, &params);

        assert_eq!(rgba.len(), 2 * 2 * 4);
        // alpha channel every 4th byte
        for (i, &v) in rgba.iter().enumerate() {
            if (i % 4) == 3 {
                assert_eq!(v, 255, "alpha must be 255");
            } else {
                assert!(v > 200);
            }
        }

        // cross-check roundtrip-ish: last 3 of each 4 should match a process() output
        let rgb8 = pipeline::process(&rgb16, &params);
        for y in 0..4 {
            for x in 0..3 {
                assert_eq!(rgba[y * 4 + x], rgb8[y * 3 + x]);
            }
        }
    }

    #[test]
    fn real_orf_parses_and_renders() {
        // Integration smoke test — requires a real ORF on this machine.
        // Skipped automatically if file absent (CI / other machines).
        let path = r"C:\995\2026-01-09 Birthday at Cederberg\P1100079.ORF";
        let data = match std::fs::read(path) {
            Ok(d) => d,
            Err(_) => return, // file not present — skip
        };

        let info = tiff::parse(&data).expect("tiff::parse failed");
        assert!(info.width > 0 && info.height > 0, "zero dimensions");
        assert!(info.wb_r.is_some(), "wb_r missing");

        let w = info.width as usize;
        let h = info.height as usize;
        let strip = &data[info.strip_offset as usize
            ..(info.strip_offset + info.strip_byte_count) as usize];
        let raw = decompress::decompress(strip, w, h).expect("decompress failed");
        assert_eq!(raw.len(), w * h, "raw pixel count wrong");

        let rgb16 = demosaic::demosaic_rggb(&raw, w, h).expect("demosaic failed");
        assert_eq!(rgb16.len(), w * h * 3);

        let mut params = pipeline::PipelineParams::default_olympus();
        if let Some(r) = info.wb_r { params.wb_r = r; }
        if let Some(b) = info.wb_b { params.wb_b = b; }
        let rgb8 = pipeline::process(&rgb16, &params);
        assert_eq!(rgb8.len(), w * h * 3);

        // Output should be non-trivial (not all-black or all-white)
        let mean: u64 = rgb8.iter().map(|&v| v as u64).sum::<u64>() / rgb8.len() as u64;
        assert!(mean > 10 && mean < 245, "mean pixel {mean} out of expected range [10..245]");

        let exif = exif::ExifData::from_orf_info(&info, w as u32, h as u32);
        assert!(exif.wb_from_camera, "wb_from_camera should be true");
    }
}
