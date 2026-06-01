use crate::tiff::OrfInfo;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Rational {
    pub num: u32,
    pub den: u32,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct GpsData {
    pub lat: f64,
    pub lon: f64,
    pub alt: f64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ExifData {
    pub make: Option<String>,
    pub model: Option<String>,
    pub lens: Option<String>,
    pub datetime: Option<String>,
    pub exposure: Option<Rational>,
    pub fnumber: Option<Rational>,
    pub iso: Option<u32>,
    pub focal_length: Option<Rational>,
    pub focal_length_35: Option<u32>,
    pub gps: Option<GpsData>,
    pub orientation: u16,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub wb_r: Option<f32>,
    pub wb_b: Option<f32>,
    pub wb_mode: Option<u16>,
    pub wb_from_camera: bool,
    pub quality: Option<u8>,
}

impl ExifData {
    pub fn from_orf_info(info: &OrfInfo, image_w: u32, image_h: u32) -> Self {
        let nonempty = |s: &str| if s.is_empty() { None } else { Some(s.to_string()) };

        let gps = if info.gps_lat.is_some() && info.gps_lon.is_some() {
            Some(GpsData {
                lat: info.gps_lat.unwrap(),
                lon: info.gps_lon.unwrap(),
                alt: info.gps_alt.unwrap_or(0.0),
            })
        } else {
            None
        };

        ExifData {
            make:           nonempty(&info.make),
            model:          nonempty(&info.model),
            lens:           nonempty(&info.lens),
            datetime:       nonempty(&info.datetime),
            exposure:       info.exposure.map(|(n, d)| Rational { num: n, den: d }),
            fnumber:        info.fnumber.map(|(n, d)| Rational { num: n, den: d }),
            iso:            info.iso,
            focal_length:   info.focal_length.map(|(n, d)| Rational { num: n, den: d }),
            focal_length_35: info.focal_length_35.map(|v| v as u32),
            gps,
            orientation:    info.orientation,
            width:          Some(image_w),
            height:         Some(image_h),
            wb_r:           info.wb_r,
            wb_b:           info.wb_b,
            wb_mode:        info.wb_mode,
            wb_from_camera: info.wb_r.is_some() && info.wb_b.is_some(),
            quality:        info.quality.map(|q| q as u8),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_info() -> OrfInfo {
        OrfInfo {
            width: 4608,
            height: 3456,
            bits_per_sample: 12,
            compression: 1,
            strip_offset: 0,
            strip_byte_count: 0,
            orientation: 1,
            make: "OLYMPUS IMAGING CORP.".to_string(),
            model: "E-M5".to_string(),
            wb_r: Some(1.78),
            wb_b: Some(1.50),
            color_matrix: None,
            black_level: 256,
            little_endian: true,
            wb_mode: Some(1),
            lens: "M.Zuiko 12-40".to_string(),
            datetime: "2024:03:15 10:30:00".to_string(),
            exposure: Some((1, 500)),
            fnumber: Some((28, 10)),
            iso: Some(200),
            focal_length: Some((40, 1)),
            focal_length_35: Some(80),
            gps_lat: Some(48.8566),
            gps_lon: Some(2.3522),
            gps_alt: Some(35.0),
            quality: Some(3),
        }
    }

    #[test]
    fn exif_from_orf_info_maps_all_fields() {
        let info = make_info();
        let exif = ExifData::from_orf_info(&info, 4608, 3456);

        assert_eq!(exif.make.as_deref(), Some("OLYMPUS IMAGING CORP."));
        assert_eq!(exif.model.as_deref(), Some("E-M5"));
        assert_eq!(exif.lens.as_deref(), Some("M.Zuiko 12-40"));
        assert_eq!(exif.datetime.as_deref(), Some("2024:03:15 10:30:00"));
        assert_eq!(exif.iso, Some(200));
        assert_eq!(exif.focal_length_35, Some(80u32));
        assert_eq!(exif.orientation, 1);
        assert_eq!(exif.width, Some(4608));
        assert_eq!(exif.height, Some(3456));
        assert_eq!(exif.wb_r, Some(1.78));
        assert_eq!(exif.wb_b, Some(1.50));
        assert!(exif.wb_from_camera);
        assert_eq!(exif.quality, Some(3));

        let exp = exif.exposure.unwrap();
        assert_eq!((exp.num, exp.den), (1, 500));

        let f = exif.fnumber.unwrap();
        assert_eq!((f.num, f.den), (28, 10));

        let gps = exif.gps.unwrap();
        assert!((gps.lat - 48.8566).abs() < 1e-4);
        assert!((gps.lon - 2.3522).abs() < 1e-4);
    }

    #[test]
    fn exif_from_orf_info_absent_fields() {
        let mut info = make_info();
        info.gps_lat = None;
        info.gps_lon = None;
        info.wb_r = None;
        info.wb_b = None;
        info.lens = String::new();
        info.datetime = String::new();
        let exif = ExifData::from_orf_info(&info, 4608, 3456);
        assert!(exif.gps.is_none());
        assert!(!exif.wb_from_camera);
        assert!(exif.lens.is_none());
        assert!(exif.datetime.is_none());
    }
}
