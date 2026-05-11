//! Olympus 12-bit raw decompression.
//!
//! Port of dcraw v9.28's `olympus_load_raw()` (David Coffin, public domain),
//! cross-checked against LibRaw 0.21.4 and the rawloader crate.
//! Algorithm: predictive variable-length encoding with a 12-bit Huffman prefix
//! table for the run-length "high" value, per-row state ("carry"), and a
//! context-dependent predictor using west / north / north-west neighbours.

/// Skip count before the bitstream begins (dcraw `fseek(ifp, 7, SEEK_CUR)`).
const HEADER_SKIP: usize = 7;

pub fn decompress(compressed: &[u8], width: usize, height: usize) -> Vec<u16> {
    let mut out = vec![0u16; width * height];
    let huff = build_huff();
    let mut br = BitReader::new(&compressed[HEADER_SKIP..]);

    for row in 0..height {
        // acarry[parity] = [last_value, running_avg_signed, stable_counter]
        // Reset per row (dcraw: `memset(acarry, 0, sizeof acarry);`).
        let mut acarry = [[0i32; 3]; 2];
        for col in 0..width {
            let parity = col & 1;
            let i = if acarry[parity][2] < 3 { 2 } else { 0 };
            let mut nbits = 2 + i;
            // dcraw uses (ushort) on carry[0] — low 16 bits unsigned.
            let carry_lo = (acarry[parity][0] as u16) as u32;
            while nbits < 16 && carry_lo >> (nbits + i) > 0 {
                nbits += 1;
            }

            let sb = br.read_bits(3);
            let low = (sb & 3) as i32;
            // arithmetic shift spreads top bit of the 3-bit field into a -1/0 mask
            let sign = (((sb as i32) << 29) >> 31) as i32;

            let high0 = br.read_huff(&huff);
            // Escape path reads (16 - nbits) bits — NOT a flat 16.  Then drop LSB.
            let high = if high0 == 12 {
                let extra = (16u32).saturating_sub(nbits as u32);
                (br.read_bits(extra) >> 1) as i32
            } else {
                high0 as i32
            };

            // carry[0] = (high << nbits) | nbits-bit literal.  `low` is NOT
            // OR'ed in here — it is applied to the diff when storing the pixel.
            acarry[parity][0] = (high << nbits) | (br.read_bits(nbits as u32) as i32);
            let diff = (acarry[parity][0] ^ sign) + acarry[parity][1];
            // Running average uses the carry's OWN previous value (carry[1]),
            // not carry[0].  This is the dcraw / LibRaw / rawloader form.
            acarry[parity][1] = (diff * 3 + acarry[parity][1]) >> 5;
            acarry[parity][2] = if acarry[parity][0] > 16 {
                0
            } else {
                acarry[parity][2] + 1
            };

            let pred = if row < 2 && col < 2 {
                0
            } else if row < 2 {
                out[row * width + col - 2] as i32
            } else if col < 2 {
                out[(row - 2) * width + col] as i32
            } else {
                let w_ = out[row * width + col - 2] as i32;
                let n_ = out[(row - 2) * width + col] as i32;
                let nw = out[(row - 2) * width + col - 2] as i32;
                if (w_ < nw && nw < n_) || (n_ < nw && nw < w_) {
                    if (w_ - nw).abs() > 32 || (n_ - nw).abs() > 32 {
                        w_ + n_ - nw
                    } else {
                        (w_ + n_) >> 1
                    }
                } else if (w_ - nw).abs() > (n_ - nw).abs() {
                    w_
                } else {
                    n_
                }
            };

            let v = pred + ((diff << 2) | low);
            out[row * width + col] = (v & 0xFFFF) as u16;
        }
    }
    out
}

fn build_huff() -> [u16; 4096] {
    let mut huff = [0u16; 4096];
    let mut n = 0usize;
    huff[0] = 0xc0c; // 12-bit lookup, escape value 12
    for i in (0..12).rev() {
        let len = 2048usize >> i;
        for _ in 0..len {
            n += 1;
            huff[n] = (((i as u16) + 1) << 8) | (i as u16);
        }
    }
    huff
}

/// MSB-first bit reader.  No byte stuffing (Olympus does not set `zero_after_ff`).
struct BitReader<'a> {
    data: &'a [u8],
    pos: usize,
    buf: u64,
    nbits: u32,
}

impl<'a> BitReader<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self {
            data,
            pos: 0,
            buf: 0,
            nbits: 0,
        }
    }

    #[inline(always)]
    fn fill(&mut self, need: u32) {
        while self.nbits < need {
            let byte = if self.pos < self.data.len() {
                let b = self.data[self.pos];
                self.pos += 1;
                b
            } else {
                0
            };
            self.buf = (self.buf << 8) | byte as u64;
            self.nbits += 8;
        }
    }

    #[inline(always)]
    fn read_bits(&mut self, n: u32) -> u32 {
        if n == 0 {
            return 0;
        }
        self.fill(n);
        let v = (self.buf >> (self.nbits - n)) & ((1u64 << n) - 1);
        self.nbits -= n;
        v as u32
    }

    #[inline(always)]
    fn read_huff(&mut self, huff: &[u16; 4096]) -> u32 {
        self.fill(12);
        let idx = ((self.buf >> (self.nbits - 12)) & 0xFFF) as usize;
        let entry = huff[idx];
        let len = (entry >> 8) as u32;
        self.nbits -= len;
        (entry & 0xff) as u32
    }
}
