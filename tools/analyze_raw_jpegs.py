from __future__ import annotations

import argparse
import json
import os
import struct
from pathlib import Path


TYPE_SIZES = {
    1: 1,  # BYTE
    2: 1,  # ASCII
    3: 2,  # SHORT
    4: 4,  # LONG
    5: 8,  # RATIONAL
    6: 1,  # SBYTE
    7: 1,  # UNDEFINED
    8: 2,  # SSHORT
    9: 4,  # SLONG
    10: 8,  # SRATIONAL
    11: 4,  # FLOAT
    12: 8,  # DOUBLE
    13: 4,  # IFD
}

TAG_NAMES = {
    0x0100: "ImageWidth",
    0x0101: "ImageLength",
    0x0103: "Compression",
    0x0106: "PhotometricInterpretation",
    0x0111: "StripOffsets",
    0x0117: "StripByteCounts",
    0x0144: "TileOffsets",
    0x0145: "TileByteCounts",
    0x014A: "SubIFDs",
    0x0201: "JPEGInterchangeFormat",
    0x0202: "JPEGInterchangeFormatLength",
    0x8769: "ExifIFDPointer",
    0x8825: "GPSInfoIFDPointer",
    0x927C: "MakerNote",
    0xC4A5: "PrintImageMatching",
}

POINTER_TAGS = {0x8769, 0x8825, 0x014A}
OFFSET_TAGS = {0x0111, 0x0144, 0x0201}
COUNT_TAGS = {0x0117, 0x0145, 0x0202}


def read_u16(data: bytes, off: int, endian: str) -> int:
    return struct.unpack_from(endian + "H", data, off)[0]


def read_u32(data: bytes, off: int, endian: str) -> int:
    return struct.unpack_from(endian + "I", data, off)[0]


def parse_scalar_values(data: bytes, off: int, typ: int, count: int, endian: str, base: int = 0) -> list[int]:
    size = TYPE_SIZES.get(typ, 1) * count
    if size <= 4:
        raw = data[off : off + 4][:size]
    else:
        ptr = read_u32(data, off, endian) + base
        if ptr < 0 or ptr + size > len(data):
            return []
        raw = data[ptr : ptr + size]

    vals: list[int] = []
    if typ in (1, 6, 7, 2):
        vals = list(raw[: min(count, 64)])
    elif typ in (3, 8):
        fmt = endian + str(count) + "H"
        vals = list(struct.unpack_from(fmt, raw, 0))
    elif typ in (4, 9, 13):
        fmt = endian + str(count) + "I"
        vals = list(struct.unpack_from(fmt, raw, 0))
    return vals


def parse_tiff(data: bytes) -> dict:
    if len(data) < 8:
        return {}
    if data[:2] == b"II":
        endian = "<"
    elif data[:2] == b"MM":
        endian = ">"
    else:
        return {}

    magic = read_u16(data, 2, endian)
    first_ifd = read_u32(data, 4, endian)
    out = {
        "endian": "II" if endian == "<" else "MM",
        "magic": magic,
        "ifds": [],
        "offset_count_pairs": [],
    }

    # ORF uses magic 0x4f52 ("OR") with normal IFD offsets.
    if first_ifd <= 0 or first_ifd >= len(data):
        return out

    seen: set[int] = set()
    queue: list[tuple[int, str]] = [(first_ifd, "IFD0")]
    while queue and len(out["ifds"]) < 64:
        ifd_off, name = queue.pop(0)
        if ifd_off in seen or ifd_off + 2 > len(data):
            continue
        seen.add(ifd_off)
        n = read_u16(data, ifd_off, endian)
        entries_off = ifd_off + 2
        next_off_pos = entries_off + n * 12
        if n > 1024 or next_off_pos + 4 > len(data):
            continue

        tags: dict[int, dict] = {}
        ifd = {"name": name, "offset": ifd_off, "entries": n, "tags": {}}
        for i in range(n):
            eoff = entries_off + i * 12
            tag = read_u16(data, eoff, endian)
            typ = read_u16(data, eoff + 2, endian)
            count = read_u32(data, eoff + 4, endian)
            value_off = eoff + 8
            vals = parse_scalar_values(data, value_off, typ, count, endian)
            tags[tag] = {"type": typ, "count": count, "values": vals}
            if tag in TAG_NAMES or tag in OFFSET_TAGS or tag in COUNT_TAGS:
                ifd["tags"][f"0x{tag:04x}:{TAG_NAMES.get(tag, '')}"] = {
                    "type": typ,
                    "count": count,
                    "values": vals[:16],
                }
            if tag in POINTER_TAGS:
                for v in vals[:32]:
                    if 0 < v < len(data):
                        queue.append((v, f"{name}.{TAG_NAMES.get(tag, hex(tag))}"))

        next_ifd = read_u32(data, next_off_pos, endian)
        if 0 < next_ifd < len(data):
            queue.append((next_ifd, f"IFD{len(out['ifds']) + 1}"))

        def add_pairs(offset_tag: int, count_tag: int, label: str) -> None:
            offs = tags.get(offset_tag, {}).get("values", [])
            counts = tags.get(count_tag, {}).get("values", [])
            for off, cnt in zip(offs, counts):
                if 0 <= off < len(data) and cnt > 0:
                    out["offset_count_pairs"].append(
                        {
                            "ifd": name,
                            "label": label,
                            "offset": off,
                            "size": cnt,
                            "end": min(off + cnt, len(data)),
                        }
                    )

        add_pairs(0x0201, 0x0202, "JPEGInterchangeFormat")
        add_pairs(0x0111, 0x0117, "Strip")
        add_pairs(0x0144, 0x0145, "Tile")
        out["ifds"].append(ifd)
    return out


def parse_jpeg_at(data: bytes, start: int) -> dict | None:
    if data[start : start + 2] != b"\xff\xd8":
        return None
    pos = start + 2
    dims = None
    sof = None
    app_markers = []
    sos_count = 0
    while pos + 1 < len(data):
        # Seek marker prefix.
        if data[pos] != 0xFF:
            nxt = data.find(b"\xff", pos)
            if nxt < 0:
                return None
            pos = nxt
        while pos < len(data) and data[pos] == 0xFF:
            pos += 1
        if pos >= len(data):
            return None
        marker = data[pos]
        pos += 1
        if marker == 0xD9:
            return {
                "offset": start,
                "end": pos,
                "size": pos - start,
                "sof": sof,
                "dims": dims,
                "app_markers": app_markers[:8],
                "sos_count": sos_count,
            }
        if marker == 0xDA:
            if pos + 2 > len(data):
                return None
            seglen = struct.unpack_from(">H", data, pos)[0]
            pos += seglen
            sos_count += 1
            eoi = data.find(b"\xff\xd9", pos)
            if eoi < 0:
                return None
            # There can be restart markers inside scan; nearest EOI is enough for preview/raw range sizing.
            return {
                "offset": start,
                "end": eoi + 2,
                "size": eoi + 2 - start,
                "sof": sof,
                "dims": dims,
                "app_markers": app_markers[:8],
                "sos_count": sos_count,
            }
        if marker in (0x01,) or 0xD0 <= marker <= 0xD7:
            continue
        if pos + 2 > len(data):
            return None
        seglen = struct.unpack_from(">H", data, pos)[0]
        if seglen < 2 or pos + seglen > len(data):
            return None
        payload = pos + 2
        if 0xE0 <= marker <= 0xEF:
            ident = data[payload : min(payload + 10, pos + seglen)]
            app_markers.append(f"APP{marker - 0xE0}:{ident.hex()}")
        if marker in {
            0xC0,
            0xC1,
            0xC2,
            0xC3,
            0xC5,
            0xC6,
            0xC7,
            0xC9,
            0xCA,
            0xCB,
            0xCD,
            0xCE,
            0xCF,
        }:
            sof = f"0x{marker:02x}"
            if payload + 5 <= pos + seglen:
                height = struct.unpack_from(">H", data, payload + 1)[0]
                width = struct.unpack_from(">H", data, payload + 3)[0]
                comps = data[payload + 5] if payload + 5 < pos + seglen else None
                dims = {"width": width, "height": height, "components": comps}
        pos += seglen
    return None


def scan_jpegs(data: bytes) -> list[dict]:
    out = []
    pos = 0
    while True:
        idx = data.find(b"\xff\xd8\xff", pos)
        if idx < 0:
            break
        parsed = parse_jpeg_at(data, idx)
        if parsed and is_plausible_jpeg(parsed):
            out.append(parsed)
            pos = max(parsed["end"], idx + 3)
        else:
            pos = idx + 3
    return out


def is_plausible_jpeg(j: dict) -> bool:
    dims = j.get("dims") or {}
    width = dims.get("width") or 0
    height = dims.get("height") or 0
    comps = dims.get("components") or 0
    if j.get("sos_count", 0) < 1:
        return False
    if not j.get("sof"):
        return False
    if width <= 0 or height <= 0 or width > 20000 or height > 20000:
        return False
    if comps not in (1, 2, 3, 4):
        return False
    return True


def classify_jpeg(j: dict, file_size: int, pairs: list[dict]) -> str:
    for p in pairs:
        if p["offset"] == j["offset"] and p["size"] == j["size"]:
            return p["label"]
        if p["offset"] <= j["offset"] and j["end"] <= p["end"]:
            return p["label"] + ":inside"
    sof = j.get("sof")
    dims = j.get("dims") or {}
    apps = j.get("app_markers") or []
    if sof == "0xc3":
        return "lossless-jpeg-raw-like"
    if apps and dims.get("components") in (1, 3):
        return "preview-jpeg-like"
    if j["size"] < 512 * 1024:
        return "thumbnail-jpeg-like"
    return "unknown-jpeg-like"


def is_rendered_skip_candidate(j: dict) -> bool:
    dims = j.get("dims") or {}
    # CR2/DNG raw image payloads are commonly lossless JPEG (SOF3) with 2/4 components.
    # Rendered previews/thumbnails in these samples are baseline JPEG (SOF0).
    return j.get("sof") == "0xc0" and dims.get("components") in (1, 3)


def analyze_file(path: Path) -> dict:
    data = path.read_bytes()
    tiff = parse_tiff(data)
    pairs = tiff.get("offset_count_pairs", [])
    jpegs = scan_jpegs(data)
    for j in jpegs:
        j["class"] = classify_jpeg(j, len(data), pairs)
        j["rendered_skip_candidate"] = is_rendered_skip_candidate(j)
    preview = [j for j in jpegs if "preview" in j["class"] or "thumbnail" in j["class"] or j["class"] == "JPEGInterchangeFormat"]
    skip_candidates = [j for j in jpegs if j["rendered_skip_candidate"]]
    return {
        "path": str(path),
        "name": path.name,
        "ext": path.suffix.lower(),
        "size": len(data),
        "tiff_magic": tiff.get("magic"),
        "ifd_count": len(tiff.get("ifds", [])),
        "pairs": pairs,
        "jpegs": jpegs,
        "preview_jpeg_total": sum(j["size"] for j in preview),
        "rendered_skip_candidate_total": sum(j["size"] for j in skip_candidates),
        "jpeg_total": sum(j["size"] for j in jpegs),
    }


def summarize(results: list[dict]) -> dict:
    by_ext: dict[str, dict] = {}
    for r in results:
        e = r["ext"]
        s = by_ext.setdefault(
            e,
            {
                "count": 0,
                "file_bytes": 0,
                "jpeg_bytes": 0,
                "preview_jpeg_bytes": 0,
                "rendered_skip_candidate_bytes": 0,
                "jpeg_count": 0,
                "classes": {},
                "preview_sizes": [],
                "rendered_skip_candidate_sizes": [],
            },
        )
        s["count"] += 1
        s["file_bytes"] += r["size"]
        s["jpeg_bytes"] += r["jpeg_total"]
        s["preview_jpeg_bytes"] += r["preview_jpeg_total"]
        s["rendered_skip_candidate_bytes"] += r["rendered_skip_candidate_total"]
        s["jpeg_count"] += len(r["jpegs"])
        for j in r["jpegs"]:
            s["classes"][j["class"]] = s["classes"].get(j["class"], 0) + 1
            if "preview" in j["class"] or "thumbnail" in j["class"] or j["class"] == "JPEGInterchangeFormat":
                s["preview_sizes"].append(j["size"])
            if j["rendered_skip_candidate"]:
                s["rendered_skip_candidate_sizes"].append(j["size"])
    for s in by_ext.values():
        ps = sorted(s["preview_sizes"])
        if ps:
            s["preview_min"] = ps[0]
            s["preview_median"] = ps[len(ps) // 2]
            s["preview_max"] = ps[-1]
        ss = sorted(s["rendered_skip_candidate_sizes"])
        if ss:
            s["rendered_skip_candidate_min"] = ss[0]
            s["rendered_skip_candidate_median"] = ss[len(ss) // 2]
            s["rendered_skip_candidate_max"] = ss[-1]
        s["preview_pct"] = 100.0 * s["preview_jpeg_bytes"] / s["file_bytes"] if s["file_bytes"] else 0.0
        s["rendered_skip_candidate_pct"] = (
            100.0 * s["rendered_skip_candidate_bytes"] / s["file_bytes"] if s["file_bytes"] else 0.0
        )
        s["jpeg_pct"] = 100.0 * s["jpeg_bytes"] / s["file_bytes"] if s["file_bytes"] else 0.0
    return by_ext


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("paths", nargs="+")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    files: list[Path] = []
    for raw in args.paths:
        p = Path(raw)
        if p.is_dir():
            files.extend(sorted(x for x in p.iterdir() if x.suffix.lower() in {".orf", ".cr2", ".dng"}))
        elif p.is_file():
            files.append(p)
    if args.limit:
        files = files[: args.limit]

    results = [analyze_file(p) for p in files]
    payload = {"summary": summarize(results), "files": results}
    if args.json:
        print(json.dumps(payload, indent=2))
    else:
        print(json.dumps(payload["summary"], indent=2))
        for r in results[:20]:
            print(
                f"{r['name']}: size={r['size']} jpegs={len(r['jpegs'])} "
                f"preview_bytes={r['preview_jpeg_total']} jpeg_bytes={r['jpeg_total']}"
            )
            for j in r["jpegs"][:8]:
                dims = j.get("dims") or {}
                print(
                    f"  {j['class']} off={j['offset']} size={j['size']} end={j['end']} "
                    f"sof={j.get('sof')} {dims.get('width')}x{dims.get('height')} c={dims.get('components')}"
                )


if __name__ == "__main__":
    main()
