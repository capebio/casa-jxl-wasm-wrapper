//! Encode with libjxl (via raw-pipeline::casabio_encode) and decode with
//! jxl-oxide. The web client uses `jxl-oxide-wasm`, which wraps the same
//! crate — so a successful decode here means the Tauri uploader's bytes
//! will round-trip through the gallery's web decoder.

use jxl_oxide::JxlImage;
use raw_pipeline::casabio_encode::{encode_variants, SourceType};

fn solid(w: u32, h: u32) -> Vec<u8> {
    (0..(w * h * 4)).map(|i| (i & 0xFF) as u8).collect()
}

#[test]
fn libjxl_encoded_variants_decode_with_oxide() {
    let rgba = solid(1024, 768);
    let v = encode_variants(&rgba, 1024, 768, SourceType::Jpeg, false).unwrap();
    for buf in [&v.thumb_300, &v.preview_1080, &v.full] {
        let img = JxlImage::builder()
            .read(buf.as_slice())
            .expect("oxide parse");
        let _ = img.render_frame(0).expect("oxide decode");
    }
}
