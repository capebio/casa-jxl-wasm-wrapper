import sys, json, subprocess
from collections import defaultdict
sys.stdout.reconfigure(encoding='utf-8')

result = subprocess.run(
    ['git', 'log', '--all', '--format=%H|%ad', '--date=short', '--numstat'],
    capture_output=True, text=True, encoding='utf-8', cwd='C:/Foo/raw-converter-wasm'
)

activity = defaultdict(lambda: defaultdict(int))
current_date = None
for line in result.stdout.splitlines():
    if '|' in line:
        parts = line.strip().split('|', 1)
        if len(parts[0]) == 40:
            current_date = parts[1]
            continue
    if current_date and '\t' in line:
        parts = line.strip().split('\t')
        if len(parts) == 3:
            try:
                added = int(parts[0]) if parts[0] != '-' else 0
                removed = int(parts[1]) if parts[1] != '-' else 0
                p = parts[2]
                activity[p][current_date] += added + removed
            except:
                pass

node_paths = {
    'crates/raw-pipeline/src/tiff.rs': 'tiff',
    'crates/raw-pipeline/src/dng.rs': 'dng_rs',
    'crates/raw-pipeline/src/cr2.rs': 'cr2_rs',
    'crates/raw-pipeline/src/exif.rs': 'exif',
    'crates/raw-pipeline/src/ljpeg.rs': 'ljpeg',
    'crates/raw-pipeline/src/decompress.rs': 'decompress',
    'crates/raw-pipeline/src/demosaic.rs': 'demosaic',
    'crates/raw-pipeline/src/pipeline.rs': 'pipeline',
    'crates/raw-pipeline/src/casabio_encode.rs': 'casabio',
    'crates/raw-pipeline/src/jxl_casaencoder.rs': 'enc_rs',
    'crates/raw-pipeline/src/jxl_casadecoder.rs': 'dec_rs',
    'crates/jxl-ffi/src/lib.rs': 'ffi_lib',
    'crates/jxl-ffi/build.rs': 'ffi_build',
    'crates/jxl-ffi/wrapper.h': 'ffi_wrap',
    'crates/raw-pipeline/src/perceptual/mod.rs': 'pc_mod',
    'crates/raw-pipeline/src/perceptual/xyb.rs': 'pc_xyb',
    'crates/raw-pipeline/src/perceptual/butteraugli.rs': 'pc_butter',
    'crates/raw-pipeline/src/perceptual/ssim.rs': 'pc_ssim',
    'crates/raw-pipeline/src/perceptual/psnr.rs': 'pc_psnr',
    'crates/raw-pipeline/src/perceptual/blur.rs': 'pc_blur',
    'crates/raw-pipeline/src/tone_simd.rs': 'tone_simd',
    'crates/raw-pipeline/src/perceptual/simd/mod.rs': 'ps_mod',
    'crates/raw-pipeline/src/perceptual/simd/avx2.rs': 'ps_avx2',
    'crates/raw-pipeline/src/perceptual/simd/avx512.rs': 'ps_avx512',
    'crates/raw-pipeline/src/perceptual/simd/wasm.rs': 'ps_wasm',
    'crates/raw-pipeline/src/perceptual/simd/scalar.rs': 'ps_scalar',
    'src/lib.rs': 'wasm_entry',
    'packages/jxl-wasm/src/bridge.cpp': 'bridge',
    'packages/jxl-session/src/decode-session.ts': 'jxl_session',
    'packages/jxl-scheduler/src/scheduler.ts': 'jxl_sched',
    'packages/jxl-worker-browser/src/decode-handler.ts': 'jxl_worker',
    'web/jxl-progressive-paint.js': 'web_paint',
}

node_activity = defaultdict(lambda: defaultdict(int))
for fpath, dates in activity.items():
    if fpath in node_paths:
        nid = node_paths[fpath]
        for d, churn in dates.items():
            node_activity[nid][d] += churn

all_dates = sorted(set(
    d for dates in activity.values() for d in dates.keys()
))

out = {
    'dates': all_dates,
    'nodes': {nid: dict(dates) for nid, dates in node_activity.items()}
}

print('Node activity:')
for nid, dates in out['nodes'].items():
    total = sum(dates.values())
    print(f'  {nid:20s} total={total:6d}')
print(f'Dates: {all_dates[0]} .. {all_dates[-1]} ({len(all_dates)} days)')
print(f'JSON size: {len(json.dumps(out))}')

with open('docs/git-heatmap-data.json', 'w', encoding='utf-8') as f:
    json.dump(out, f, separators=(',', ':'))
print('Written docs/git-heatmap-data.json')
