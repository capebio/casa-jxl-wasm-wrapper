# build-parallel-wasm.ps1
# Builds raw-converter-wasm with --features parallel-wasm (rayon thread pool).
#
# This produces a build that:
# - Uses rayon (via wasm-bindgen-rayon) for demosaic/tonemap/downscale in RAW pipeline.
# - Requires the host page to set COOP/COEP headers (already done for libjxl MT).
# - The emitted glue now tolerates import under Node (for node-based benches like
#   benchmark/deep-dive-tests.mjs) by guarding browser-only top-level code.
#
# Prerequisites (one-time):
#   rustup toolchain install nightly --target wasm32-unknown-unknown
#   rustup component add rust-src --toolchain nightly
#
# Usage:
#   .\build-parallel-wasm.ps1
#
# Outputs to both pkg/ (primary, for node tooling + /pkg/ via serve) and web/pkg/
# (for web/ relative imports in browser demos).

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot  = $PSScriptRoot
# Discover the wasm-bindgen binary shipped by wasm-pack (hash varies by install).
$wasmBindgen = Get-ChildItem "$env:LOCALAPPDATA\.wasm-pack" -Recurse -Filter "wasm-bindgen.exe" -ErrorAction SilentlyContinue |
    Select-Object -First 1 -ExpandProperty FullName
if (-not $wasmBindgen) { $wasmBindgen = "wasm-bindgen" }  # fall back to PATH
$pkgDir    = Join-Path $repoRoot "pkg"
$webPkgDir = Join-Path $repoRoot "web\pkg"

Write-Host "=== parallel-wasm: cargo +nightly build ===" -ForegroundColor Cyan

# Atomics + bulk-memory + mutable-globals required by wasm-bindgen-rayon.
$env:RUSTFLAGS = "-C target-feature=+atomics,+bulk-memory,+mutable-globals -C link-arg=--max-memory=4294967296"

Push-Location $repoRoot
try {
    # -Z build-std rebuilds std/panic_abort with atomics so rayon Mutex works in Wasm threads.
    cargo +nightly build `
        --lib `
        --target wasm32-unknown-unknown `
        --release `
        --features parallel-wasm `
        -Z build-std=std,panic_abort

    if ($LASTEXITCODE -ne 0) { throw "cargo build failed" }

    $wasmIn = Join-Path $repoRoot "target\wasm32-unknown-unknown\release\raw_converter_wasm.wasm"

    function Invoke-Bindgen($outDir) {
        Write-Host "=== wasm-bindgen -> $outDir ===" -ForegroundColor Cyan
        & $wasmBindgen $wasmIn --out-dir $outDir --target web
        if ($LASTEXITCODE -ne 0) { throw "wasm-bindgen failed for $outDir" }

        # Patch any emitted workerHelpers.js so the module can be imported in Node
        # (deep-dive-tests.mjs and other tooling) without ReferenceError on `self`.
        # The guard is a no-op in real browsers/workers. Idempotent.
        Get-ChildItem -Path (Join-Path $outDir "snippets") -Recurse -Filter "workerHelpers.js" -ErrorAction SilentlyContinue | ForEach-Object {
            $f = $_.FullName
            $raw = Get-Content $f -Raw -ErrorAction SilentlyContinue
            if ($raw -and ($raw -notmatch "Guard: only attach the worker-entry listener")) {
                Write-Host "  patching $f for node/browser cross-compat"
                $lines = Get-Content $f
                $outLines = New-Object System.Collections.Generic.List[string]
                $inWait = $false
                $addedIf = $false
                for ($i = 0; $i -lt $lines.Count; $i++) {
                    $line = $lines[$i]
                    if (-not $inWait -and $line -match "waitForMsgType\(self, 'wasm_bindgen_worker_init'\)") {
                        $inWait = $true
                        $addedIf = $true
                        $indent = ($line -replace '^(\s*).*', '$1')
                        $outLines.Add($indent + "// Guard: only attach the worker-entry listener when we are in an environment")
                        $outLines.Add($indent + "// that looks like a Web Worker (or main thread in browser). Prevents crashes")
                        $outLines.Add($indent + "// when the parallel-wasm glue is imported under Node (for benchmarks / tooling)")
                        $outLines.Add($indent + "// or other non-browser hosts. The listener is only needed for the child worker")
                        $outLines.Add($indent + "// instances created by startWorkers().")
                        $outLines.Add($indent + "if (typeof self !== 'undefined' && typeof self.addEventListener === 'function') {")
                        $outLines.Add($line)  # the original waitFor... line, will be inside the if
                        continue
                    }
                    if ($inWait -and $line -match '^\s*\}\);$') {
                        # this is the closing of the .then( ... });
                        $outLines.Add($line)
                        $outLines.Add("}")  # close the if
                        $inWait = $false
                        continue
                    }
                    $outLines.Add($line)
                }
                if ($addedIf) {
                    Set-Content -Path $f -Value ($outLines -join "`r`n") -NoNewline
                } else {
                    # Fallback: prepend wrapper (less pretty indent but guarantees load)
                    $wrapped = "// Guard: only attach... (node safety)`nif (typeof self !== 'undefined' && typeof self.addEventListener === 'function') {`n" + $raw + "`n}`n"
                    Set-Content -Path $f -Value $wrapped -NoNewline
                }
            }
        }
    }

    Invoke-Bindgen $pkgDir
    Invoke-Bindgen $webPkgDir

    # wasm-opt is bundled in wasm-pack; try to find it or skip.
    $wasmOptBin = Get-ChildItem "$env:LOCALAPPDATA\.wasm-pack" -Recurse -Filter "wasm-opt.exe" -ErrorAction SilentlyContinue |
        Select-Object -First 1 -ExpandProperty FullName
    if ($wasmOptBin) {
        Write-Host "=== wasm-opt (threads + bulk-mem) ===" -ForegroundColor Cyan
        foreach ($d in @($pkgDir, $webPkgDir)) {
            $wasmOut = Join-Path $d "raw_converter_wasm_bg.wasm"
            if (Test-Path $wasmOut) {
                & $wasmOptBin $wasmOut -O2 --enable-threads --enable-bulk-memory -o $wasmOut | Out-Null
            }
        }
    } else {
        Write-Host "wasm-opt not found in wasm-pack cache — skipping optimisation" -ForegroundColor Yellow
    }

    Write-Host "=== done ===" -ForegroundColor Green
    Write-Host "Outputs: $pkgDir and $webPkgDir"
} finally {
    Pop-Location
    $env:RUSTFLAGS = ""
}
