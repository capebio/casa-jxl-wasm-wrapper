//! TIFF/ORF IFD parser. Hand-rolled for Olympus Raw Format.
//!
//! Olympus ORF uses TIFF container with non-standard magic bytes (IIRO/IIRS/IIUS).
//! We walk IFD0 to find image dimensions, strip offset, compression mode, and
//! descend into Exif IFD → Olympus MakerNote IFD for white balance and black level.

pub type Result<T> = std::result::Result<T, String>;
macro_rules! bail { ($($t:tt)*) => { return Err(format!($($t)*)) }; }
macro_rules! anyhow { ($($t:tt)*) => { format!($($t)*) }; }
pub(crate) use bail;
pub(crate) use anyhow;

#[derive(Debug, Clone)]
pub struct OrfInfo {
    pub width: u32,
    pub height: u32,
    pub bits_per_sample: u16,
    pub compression: u16,
    pub strip_offset: u32,
    pub strip_byte_count: u32,
    pub orientation: u16,
    pub make: String,
    pub model: String,
    pub wb_r: Option<f32>,
    pub wb_b: Option<f32>,
    pub color_matrix: Option<[[f32; 3]; 3]>,
    #[allow(dead_code)]
    pub black_level: u16,
    #[allow(dead_code)]
    pub little_endian: bool,
    // Olympus CameraSettings WhiteBalance2 mode (0x0500). When set to a
    // user-defined mode (One-Touch/Custom 256-259, 512-515) the stored
    // 0x0100 WB_RBLevels is a fixed calibration that won't match per-shot
    // lighting — caller can choose to discard it and gray-world instead.
    pub wb_mode: Option<u16>,
    pub lens: String,
    pub datetime: String,
    pub exposure: Option<(u32, u32)>,
    pub fnumber: Option<(u32, u32)>,
    pub iso: Option<u32>,
    pub focal_length: Option<(u32, u32)>,
    pub focal_length_35: Option<u16>,
    pub gps_lat: Option<f64>,
    pub gps_lon: Option<f64>,
    pub gps_alt: Option<f64>,
    pub quality: Option<u16>,
}

pub fn parse(data: &[u8]) -> Result<OrfInfo> {
    if data.len() < 8 {
        bail!("file too small ({}B)", data.len());
    }

    let (little_endian, ifd0_offset) = parse_header(data)?;
    let r = Reader { data, le: little_endian };

    let mut info = OrfInfo {
        width: 0,
        height: 0,
        bits_per_sample: 12,
        compression: 1,
        strip_offset: 0,
        strip_byte_count: 0,
        orientation: 1,
        make: String::new(),
        model: String::new(),
        wb_r: None,
        wb_b: None,
        color_matrix: None,
        black_level: 0,
        little_endian,
        wb_mode: None,
        lens: String::new(),
        datetime: String::new(),
        exposure: None,
        fnumber: None,
        iso: None,
        focal_length: None,
        focal_length_35: None,
        gps_lat: None,
        gps_lon: None,
        gps_alt: None,
        quality: None,
    };

    let ifd0 = read_ifd(&r, ifd0_offset)?;
    let mut exif_offset: u32 = 0;
    let mut gps_offset: u32 = 0;

    for entry in &ifd0 {
        match entry.tag {
            0x0100 => info.width = entry.as_u32(&r)?,
            0x0101 => info.height = entry.as_u32(&r)?,
            0x0102 => info.bits_per_sample = entry.as_u32(&r)? as u16,
            0x0103 => info.compression = entry.as_u32(&r)? as u16,
            0x0111 => info.strip_offset = entry.as_u32(&r)?,
            0x0112 => info.orientation = entry.as_u32(&r)? as u16,
            0x0117 => info.strip_byte_count = entry.as_u32(&r)?,
            0x010F => info.make = entry.as_ascii(&r),
            0x0110 => info.model = entry.as_ascii(&r),
            0x0132 => if info.datetime.is_empty() { info.datetime = entry.as_ascii(&r); },
            0x8769 => exif_offset = entry.as_u32(&r)?,
            0x8825 => gps_offset = entry.as_u32(&r)?,
            _ => {}
        }
    }

    if info.width == 0 || info.height == 0 || info.strip_offset == 0 || info.strip_byte_count == 0 {
        bail!(
            "missing required tags (w={}, h={}, strip={}, byte_count={})",
            info.width,
            info.height,
            info.strip_offset,
            info.strip_byte_count,
        );
    }

    if exif_offset > 0 {
        if let Ok(exif) = read_ifd(&r, exif_offset) {
            for entry in &exif {
                match entry.tag {
                    0x829A => info.exposure = entry.as_rational(&r),
                    0x829D => info.fnumber  = entry.as_rational(&r),
                    0x8827 => info.iso      = entry.as_u32(&r).ok(),
                    0x9003 => if info.datetime.is_empty() || info.datetime.starts_with("0000") {
                        info.datetime = entry.as_ascii(&r);
                    },
                    0x920A => info.focal_length    = entry.as_rational(&r),
                    0xA405 => info.focal_length_35 = entry.as_u32(&r).ok().map(|v| v as u16),
                    0xA434 => if info.lens.is_empty() { info.lens = entry.as_ascii(&r); },
                    0x927C => parse_olympus_makernote(&r, entry, &mut info),
                    _ => {}
                }
            }
        }
    }

    if gps_offset > 0 {
        if let Ok(gps) = read_ifd(&r, gps_offset) {
            parse_gps_ifd(&r, &gps, &mut info);
        }
    }

    Ok(info)
}

fn parse_gps_ifd(r: &Reader, entries: &[IfdEntry], info: &mut OrfInfo) {
    let mut lat_ref = b'N';
    let mut lon_ref = b'E';
    let mut alt_ref: u8 = 0;
    let mut lat_dms: Option<[(u32, u32); 3]> = None;
    let mut lon_dms: Option<[(u32, u32); 3]> = None;
    let mut alt: Option<(u32, u32)> = None;
    for e in entries {
        match e.tag {
            0x0001 => { let s = e.as_ascii(r); if let Some(c) = s.bytes().next() { lat_ref = c; } }
            0x0002 => lat_dms = e.as_rational_triplet(r),
            0x0003 => { let s = e.as_ascii(r); if let Some(c) = s.bytes().next() { lon_ref = c; } }
            0x0004 => lon_dms = e.as_rational_triplet(r),
            0x0005 => alt_ref = e.as_u32(r).unwrap_or(0) as u8,
            0x0006 => alt = e.as_rational(r),
            _ => {}
        }
    }
    let to_deg = |dms: [(u32, u32); 3], r: u8| -> f64 {
        let d = dms[0].0 as f64 / dms[0].1.max(1) as f64;
        let m = dms[1].0 as f64 / dms[1].1.max(1) as f64;
        let s = dms[2].0 as f64 / dms[2].1.max(1) as f64;
        let v = d + m / 60.0 + s / 3600.0;
        if r == b'S' || r == b'W' { -v } else { v }
    };
    if let Some(d) = lat_dms { info.gps_lat = Some(to_deg(d, lat_ref)); }
    if let Some(d) = lon_dms { info.gps_lon = Some(to_deg(d, lon_ref)); }
    if let Some((n, d)) = alt {
        let v = n as f64 / d.max(1) as f64;
        info.gps_alt = Some(if alt_ref == 1 { -v } else { v });
    }
}

fn parse_header(data: &[u8]) -> Result<(bool, u32)> {
    let magic = &data[0..4];
    let le = match magic {
        b"IIRO" | b"IIRS" | b"IIUS" => true,
        [0x49, 0x49, 0x2A, 0x00] => true,
        b"MMOR" | b"MMMR" => false,
        [0x4D, 0x4D, 0x00, 0x2A] => false,
        _ => bail!("unknown magic: {:?}", magic),
    };
    let r = Reader { data, le };
    let ifd0 = r.u32(4)?;
    Ok((le, ifd0))
}

#[derive(Clone, Copy)]
struct Reader<'a> {
    data: &'a [u8],
    le: bool,
}

impl<'a> Reader<'a> {
    fn u16(&self, off: usize) -> Result<u16> {
        let b = self
            .data
            .get(off..off + 2)
            .ok_or_else(|| anyhow!("u16 OOB at {:#x}", off))?;
        Ok(if self.le {
            u16::from_le_bytes([b[0], b[1]])
        } else {
            u16::from_be_bytes([b[0], b[1]])
        })
    }

    fn u32(&self, off: usize) -> Result<u32> {
        let b = self
            .data
            .get(off..off + 4)
            .ok_or_else(|| anyhow!("u32 OOB at {:#x}", off))?;
        Ok(if self.le {
            u32::from_le_bytes([b[0], b[1], b[2], b[3]])
        } else {
            u32::from_be_bytes([b[0], b[1], b[2], b[3]])
        })
    }
}

#[derive(Debug, Clone, Copy)]
struct IfdEntry {
    tag: u16,
    dtype: u16,
    count: u32,
    value_off: u32,
}

impl IfdEntry {
    fn as_u32(&self, r: &Reader) -> Result<u32> {
        match self.dtype {
            3 => {
                if self.count == 1 {
                    // Inline SHORT: occupies the first 2 bytes of the 4-byte value
                    // field.  For LE files the value lands in the low 16 bits of the
                    // already-decoded u32; for BE files it lands in the high 16 bits.
                    let v = if r.le {
                        self.value_off & 0xFFFF
                    } else {
                        self.value_off >> 16
                    };
                    Ok(v)
                } else {
                    Ok(r.u16(self.value_off as usize)? as u32)
                }
            }
            4 => Ok(self.value_off),
            _ => Ok(self.value_off),
        }
    }

    fn as_ascii(&self, r: &Reader) -> String {
        if self.count <= 4 {
            return String::new();
        }
        let bytes = r
            .data
            .get(self.value_off as usize..(self.value_off + self.count) as usize)
            .unwrap_or(&[]);
        String::from_utf8_lossy(bytes)
            .trim_end_matches('\0')
            .trim_end()
            .to_string()
    }

    /// RATIONAL (dtype=5) or SRATIONAL (dtype=10): 8-byte numerator/denominator
    /// pair stored at the value offset (always a pointer — 8 bytes > 4 inline).
    fn as_rational(&self, r: &Reader) -> Option<(u32, u32)> {
        if self.dtype != 5 && self.dtype != 10 { return None; }
        let p = self.value_off as usize;
        let n = r.u32(p).ok()?;
        let d = r.u32(p + 4).ok()?;
        Some((n, d))
    }

    /// Three RATIONAL values in a row (24 bytes via pointer). Used for GPS
    /// latitude/longitude (degrees, minutes, seconds).
    fn as_rational_triplet(&self, r: &Reader) -> Option<[(u32, u32); 3]> {
        if self.dtype != 5 || self.count < 3 { return None; }
        let p = self.value_off as usize;
        let n0 = r.u32(p).ok()?;
        let d0 = r.u32(p + 4).ok()?;
        let n1 = r.u32(p + 8).ok()?;
        let d1 = r.u32(p + 12).ok()?;
        let n2 = r.u32(p + 16).ok()?;
        let d2 = r.u32(p + 20).ok()?;
        Some([(n0, d0), (n1, d1), (n2, d2)])
    }
}

fn read_ifd(r: &Reader, offset: u32) -> Result<Vec<IfdEntry>> {
    let off = offset as usize;
    let count = r.u16(off)? as usize;
    let mut entries = Vec::with_capacity(count);
    for i in 0..count {
        let e = off + 2 + i * 12;
        entries.push(IfdEntry {
            tag: r.u16(e)?,
            dtype: r.u16(e + 2)?,
            count: r.u32(e + 4)?,
            value_off: r.u32(e + 8)?,
        });
    }
    Ok(entries)
}

/// Olympus MakerNote header variants:
///   "OLYMP\0II\x03\0" + ...  (legacy)
///   "OLYMPUS\0II\x03\0" + ...  (E-system, modern; offsets are absolute in file)
///   "OM SYSTEM\0II..." (newer OM cameras)
fn parse_olympus_makernote(r: &Reader, entry: &IfdEntry, info: &mut OrfInfo) {
    let off = entry.value_off as usize;
    let data = r.data;
    if off + 12 > data.len() {
        return;
    }
    let head = &data[off..off + 12];
    // Try modern OLYMPUS header (12 bytes), then legacy OLYMP (8 bytes).
    let (sub_off, base_off) = if head.starts_with(b"OLYMPUS\0") {
        (off + 12, off)
    } else if head.starts_with(b"OLYMP\0") {
        (off + 8, 0)
    } else if head.starts_with(b"OM SYSTEM\0") {
        (off + 16, off)
    } else {
        (off, 0)
    };

    let sub = Reader { data, le: r.le };
    let Ok(count) = sub.u16(sub_off) else {
        return;
    };

    // OLYMPUS\0 / OM SYSTEM\0: IFD value-offsets are relative to the MakerNote start
    // (base_off). OLYMP\0 legacy uses absolute file offsets (base_off == 0).
    let abs = |v: u32| base_off + v as usize;

    // Extract the first inline SHORT from an IFD value field.
    // TIFF stores SHORT[1] or SHORT[2] directly in the 4-byte value field when
    // count*2 ≤ 4.  Must NOT treat it as a file pointer.
    let inline_u16 = |v: u32| -> u16 {
        if sub.le { (v & 0xFFFF) as u16 } else { (v >> 16) as u16 }
    };

    for i in 0..count as usize {
        let e_off = sub_off + 2 + i * 12;
        let Ok(tag) = sub.u16(e_off) else { return };
        let Ok(dtype) = sub.u16(e_off + 2) else { return };
        let Ok(cnt) = sub.u32(e_off + 4) else { return };
        let Ok(val) = sub.u32(e_off + 8) else { return };
        match tag {
            // Top-level Olympus MakerNote Quality (SHORT[1]) — 1=SQ, 2=HQ, 3=SHQ, 4=RAW
            0x0201 if dtype == 3 && cnt <= 2 => {
                info.quality = Some(inline_u16(val));
            }
            // Equipment sub-IFD — has LensModel (0x0202).
            0x2010 => {
                let _ = parse_equipment_subifd(&sub, base_off as u32 + val, base_off, info);
            }
            // CameraSettings sub-IFD — has WhiteBalance2 (0x0500).
            0x2020 => {
                let _ = parse_camera_settings_subifd(&sub, base_off as u32 + val, base_off, info);
            }
            // RedBalance: SHORT×1, inline value, × 256
            0x1017 => {
                if dtype == 3 && cnt >= 1 {
                    let v = if cnt <= 2 {
                        inline_u16(val)
                    } else if let Ok(v) = sub.u16(abs(val)) {
                        v
                    } else {
                        continue;
                    };
                    info.wb_r = Some(v as f32 / 256.0);
                }
            }
            // BlueBalance: SHORT×1, inline value, × 256
            0x1018 => {
                if dtype == 3 && cnt >= 1 {
                    let v = if cnt <= 2 {
                        inline_u16(val)
                    } else if let Ok(v) = sub.u16(abs(val)) {
                        v
                    } else {
                        continue;
                    };
                    info.wb_b = Some(v as f32 / 256.0);
                }
            }
            // WB_RBLevels: SHORT×2 inline (4 bytes fits in value field), × 256
            0x1029 => {
                if dtype == 3 && cnt >= 2 {
                    let (a, b) = if cnt <= 2 {
                        if sub.le {
                            ((val & 0xFFFF) as u16, (val >> 16) as u16)
                        } else {
                            ((val >> 16) as u16, (val & 0xFFFF) as u16)
                        }
                    } else {
                        let p = abs(val);
                        match (sub.u16(p), sub.u16(p + 2)) {
                            (Ok(a), Ok(b)) => (a, b),
                            _ => continue,
                        }
                    };
                    info.wb_r = Some(a as f32 / 256.0);
                    info.wb_b = Some(b as f32 / 256.0);
                }
            }
            // ImageProcessing sub-IFD — contains WB_RBLevels (tag 0x0100) on
            // modern E-M1 II/III and OM-1 bodies.
            0x2040 => {
                let _ = parse_image_processing_subifd(&sub, base_off as u32 + val, base_off, info);
            }
            // ColorMatrix: SSHORT×9 — always a pointer (18 bytes > 4)
            0x1011 => {
                if cnt == 9 {
                    let p = abs(val);
                    let mut m = [[0f32; 3]; 3];
                    let mut ok = true;
                    'outer: for row in 0..3 {
                        for col in 0..3 {
                            match sub.u16(p + (row * 3 + col) * 2) {
                                Ok(v) => m[row][col] = (v as i16) as f32 / 256.0,
                                Err(_) => { ok = false; break 'outer; }
                            }
                        }
                    }
                    if ok {
                        info.color_matrix = Some(m);
                    }
                }
            }
            _ => {}
        }
    }
}

fn parse_equipment_subifd(r: &Reader, off: u32, base_off: usize, info: &mut OrfInfo) -> Result<()> {
    let p = off as usize;
    if p + 2 > r.data.len() { return Ok(()); }
    let count = r.u16(p)?;
    for i in 0..count as usize {
        let e = p + 2 + i * 12;
        if e + 12 > r.data.len() { break; }
        let tag = r.u16(e)?;
        let dtype = r.u16(e + 2)?;
        let cnt = r.u32(e + 4)?;
        let val = r.u32(e + 8)?;
        // 0x0203 LensModel (ASCII). Value offsets in Olympus sub-IFDs are
        // relative to the MakerNote base (same as parse_image_processing_subifd).
        // (0x0202 is LensSerialNumber — a hex string, not the human name.)
        if tag == 0x0203 && dtype == 2 && cnt > 4 {
            let start = base_off + val as usize;
            let end = start + cnt as usize;
            if let Some(bytes) = r.data.get(start..end.min(r.data.len())) {
                info.lens = String::from_utf8_lossy(bytes)
                    .trim_end_matches('\0')
                    .trim()
                    .to_string();
            }
        }
    }
    Ok(())
}

fn parse_camera_settings_subifd(r: &Reader, off: u32, _base_off: usize, info: &mut OrfInfo) -> Result<()> {
    let p = off as usize;
    if p + 2 > r.data.len() { return Ok(()); }
    let count = r.u16(p)?;
    for i in 0..count as usize {
        let e = p + 2 + i * 12;
        if e + 12 > r.data.len() { break; }
        let tag = r.u16(e)?;
        let dtype = r.u16(e + 2)?;
        let _cnt = r.u32(e + 4)?;
        let val = r.u32(e + 8)?;
        // 0x0500 WhiteBalance2 — SHORT[1], inline. Low 16 bits on LE.
        if tag == 0x0500 && dtype == 3 {
            let v = if r.le { (val & 0xFFFF) as u16 } else { (val >> 16) as u16 };
            info.wb_mode = Some(v);
        }
    }
    Ok(())
}

fn parse_image_processing_subifd(r: &Reader, off: u32, base_off: usize, info: &mut OrfInfo) -> Result<()> {
    let p = off as usize;
    if p + 2 > r.data.len() {
        return Ok(());
    }
    let count = r.u16(p)?;
    for i in 0..count as usize {
        let e = p + 2 + i * 12;
        if e + 12 > r.data.len() {
            break;
        }
        let tag = r.u16(e)?;
        let dtype = r.u16(e + 2)?;
        let cnt = r.u32(e + 4)?;
        let val = r.u32(e + 8)?;
        // WB_RBLevels: format [R_balance, B_balance, G_ref, G_ref] where
        // each value is the channel gain ×256 (G_ref = 256 = unity).
        // ptr+0 = R gain ×256, ptr+2 = B gain ×256.
        if tag == 0x0100 && dtype == 3 && cnt >= 2 {
            let (r_lvl, b_lvl) = if cnt == 2 {
                // Inline: both SHORTs in the 4-byte value field.
                let bytes = val.to_le_bytes();
                let r_v = if r.le {
                    u16::from_le_bytes([bytes[0], bytes[1]])
                } else {
                    u16::from_be_bytes([bytes[0], bytes[1]])
                };
                let b_v = if r.le {
                    u16::from_le_bytes([bytes[2], bytes[3]])
                } else {
                    u16::from_be_bytes([bytes[2], bytes[3]])
                };
                (r_v, b_v)
            } else {
                let ptr = base_off + val as usize;
                (r.u16(ptr)?, r.u16(ptr + 2)?)
            };
            if r_lvl > 0 && b_lvl > 0 {
                info.wb_r = Some(r_lvl as f32 / 256.0);
                info.wb_b = Some(b_lvl as f32 / 256.0);
            }
        }
        // ColorMatrix: SSHORT×9 packed as CamRGB→sRGB (÷256).  Row sums ~1.
        if tag == 0x0200 && cnt == 9 && (dtype == 3 || dtype == 8) {
            let ptr = base_off + val as usize;
            let mut m = [[0f32; 3]; 3];
            let mut ok = true;
            'cm: for row in 0..3 {
                for col in 0..3 {
                    match r.u16(ptr + (row * 3 + col) * 2) {
                        Ok(v) => m[row][col] = (v as i16) as f32 / 256.0,
                        Err(_) => { ok = false; break 'cm; }
                    }
                }
            }
            if ok { info.color_matrix = Some(m); }
        }
    }
    Ok(())
}
