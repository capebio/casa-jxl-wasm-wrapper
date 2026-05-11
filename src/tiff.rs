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
    };

    let ifd0 = read_ifd(&r, ifd0_offset)?;
    let mut exif_offset: u32 = 0;

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
            0x8769 => exif_offset = entry.as_u32(&r)?,
            _ => {}
        }
    }

    if info.width == 0 || info.height == 0 || info.strip_offset == 0 {
        bail!(
            "missing required tags (w={}, h={}, strip={})",
            info.width,
            info.height,
            info.strip_offset
        );
    }

    if exif_offset > 0 {
        if let Ok(exif) = read_ifd(&r, exif_offset) {
            for entry in &exif {
                if entry.tag == 0x927C {
                    parse_olympus_makernote(&r, entry, &mut info);
                }
            }
        }
    }

    Ok(info)
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
                    let bytes = self.value_off.to_le_bytes();
                    Ok(u16::from_le_bytes([bytes[0], bytes[1]]) as u32)
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
            .to_string()
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
    let _ = base_off;

    let sub = Reader { data, le: r.le };
    let Ok(count) = sub.u16(sub_off) else {
        return;
    };
    for i in 0..count as usize {
        let e_off = sub_off + 2 + i * 12;
        let Ok(tag) = sub.u16(e_off) else { return };
        let Ok(dtype) = sub.u16(e_off + 2) else { return };
        let Ok(cnt) = sub.u32(e_off + 4) else { return };
        let Ok(val) = sub.u32(e_off + 8) else { return };
        match tag {
            0x1017 => {
                // RedBalance: 2 SHORTs, value × 256
                if dtype == 3 && cnt >= 1 {
                    if let Ok(v) = sub.u16(val as usize) {
                        info.wb_r = Some(v as f32 / 256.0);
                    }
                }
            }
            0x1018 => {
                if dtype == 3 && cnt >= 1 {
                    if let Ok(v) = sub.u16(val as usize) {
                        info.wb_b = Some(v as f32 / 256.0);
                    }
                }
            }
            // 0x1029 (WB_RBLevels) - 2 SHORTs scaled by /256
            0x1029 => {
                if dtype == 3 && cnt >= 2 {
                    let p = val as usize;
                    if let (Ok(a), Ok(b)) = (sub.u16(p), sub.u16(p + 2)) {
                        info.wb_r = Some(a as f32 / 256.0);
                        info.wb_b = Some(b as f32 / 256.0);
                    }
                }
            }
            // 0x2040 ImageProcessing sub-IFD — descend and look for tag
            // 0x0100 (WB_RBLevels: 2 SHORTs × 256) which is where modern
            // Olympus bodies (E-M1 II/III, OM-1) actually store WB.
            0x2040 => {
                let _ = parse_image_processing_subifd(&sub, val, info);
            }
            0x1011 => {
                if cnt == 9 {
                    let p = val as usize;
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

fn parse_image_processing_subifd(r: &Reader, off: u32, info: &mut OrfInfo) -> Result<()> {
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
        if tag == 0x0100 && dtype == 3 && cnt >= 2 {
            // Inline if cnt*2 ≤ 4 bytes, else value_off is a pointer.
            let (r_lvl, b_lvl) = if cnt == 2 {
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
                (r.u16(val as usize)?, r.u16(val as usize + 2)?)
            };
            if r_lvl > 0 && b_lvl > 0 {
                info.wb_r = Some(r_lvl as f32 / 256.0);
                info.wb_b = Some(b_lvl as f32 / 256.0);
            }
        }
    }
    Ok(())
}
