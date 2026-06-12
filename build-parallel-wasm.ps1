# build-parallel-wasm.ps1
# Builds raw-converter-wasm with configurable cargo features (default: parallel-wasm).
#
# This produces a build that:
# - Uses rayon (via wasm-bindgen-rayon) for demosaic/tonemap/downscale in RAW pipeline.
# - Requires the host page to set COOP/COEP headers (already done for libjxl MT).
# - The emitted glue now tolerates import under Node for benchmark/tooling use.
#
# Prerequisites (one-time):
#   rustup toolchain install nightly-2026-06-01 --target wasm32-unknown-unknown
#   rustup component add rust-src --toolchain nightly-2026-06-01
#
# Usage:
#   .\build-parallel-wasm.ps1

param([string[]]$Features = @('parallel-wasm'))

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = $PSScriptRoot
$pkgDir = Join-Path $repoRoot "pkg"
$webPkgDir = Join-Path $repoRoot "web\pkg"
$cargoLockPath = Join-Path $repoRoot "Cargo.lock"
$nightly = "nightly-2026-06-01"
$savedRustflags = $env:RUSTFLAGS
$savedPath = $env:PATH

function Get-WasmBindgenVersion {
    $lockText = Get-Content $cargoLockPath -Raw
    $match = [regex]::Match($lockText, 'name = "wasm-bindgen"\s+version = "([^"]+)"', [System.Text.RegularExpressions.RegexOptions]::Singleline)
    if (-not $match.Success) { throw "Could not find wasm-bindgen version in Cargo.lock" }
    return $match.Groups[1].Value
}

function Resolve-WasmBindgenCli([string]$version) {
    $cacheRoot = Join-Path $env:LOCALAPPDATA ".wasm-pack"
    $candidates = @()
    if (Test-Path $cacheRoot) {
        $candidates = Get-ChildItem $cacheRoot -Recurse -Filter "wasm-bindgen.exe" -ErrorAction SilentlyContinue
    }
    foreach ($candidate in $candidates) {
        try {
            $reported = & $candidate.FullName --version
            if ($LASTEXITCODE -eq 0 -and $reported -match [regex]::Escape($version)) {
                return $candidate.FullName
            }
        } catch {}
    }
    throw "wasm-bindgen-cli $version not found. Run: cargo install wasm-bindgen-cli --version $version"
}

function Resolve-WasmOptBin {
    $cacheRoot = Join-Path $env:LOCALAPPDATA ".wasm-pack"
    if (-not (Test-Path $cacheRoot)) { return $null }
    return Get-ChildItem $cacheRoot -Recurse -Filter "wasm-opt.exe" -ErrorAction SilentlyContinue |
        Select-Object -First 1 -ExpandProperty FullName
}

function Assert-RustupComponent([string]$toolchain, [string]$component) {
    $installed = & rustup component list --toolchain $toolchain
    if ($LASTEXITCODE -ne 0) { throw "rustup component list failed for $toolchain" }
    if (-not ($installed | Select-String "^$component.*\(installed\)$" -Quiet)) {
        throw "$component missing for $toolchain. Run: rustup toolchain install $toolchain --target wasm32-unknown-unknown; rustup component add $component --toolchain $toolchain"
    }
}

function Invoke-Bindgen([string]$wasmBindgen, [string]$wasmIn, [string]$outDir) {
    Write-Host "=== wasm-bindgen -> $outDir ===" -ForegroundColor Cyan
    & $wasmBindgen $wasmIn --out-dir $outDir --target web
    if ($LASTEXITCODE -ne 0) { throw "wasm-bindgen failed for $outDir" }

    # Version pinning keeps upstream emission shape stable enough for this line-oriented patch.
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
                    $outLines.Add($line)
                    continue
                }
                if ($inWait -and $line -match '^\s*\}\);$') {
                    $outLines.Add($line)
                    $outLines.Add("}")
                    $inWait = $false
                    continue
                }
                $outLines.Add($line)
            }
            if ($addedIf) {
                Set-Content -Path $f -Value ($outLines -join "`r`n") -NoNewline
            } else {
                $wrapped = "// Guard: only attach... (node safety)`nif (typeof self !== 'undefined' && typeof self.addEventListener === 'function') {`n" + $raw + "`n}`n"
                Set-Content -Path $f -Value $wrapped -NoNewline
            }
        }
    }
}

function Invoke-WasmOpt([string]$wasmOptBin, [string]$wasmOut) {
    $tmp = "$wasmOut.opt"
    & $wasmOptBin $wasmOut -O2 --enable-threads --enable-bulk-memory --enable-simd `
        --enable-mutable-globals --enable-nontrapping-float-to-int --enable-sign-ext `
        -o $tmp
    if ($LASTEXITCODE -ne 0) {
        if (Test-Path $tmp) { Remove-Item -Force $tmp }
        throw "wasm-opt failed for $wasmOut"
    }
    Move-Item -Force $tmp $wasmOut
}

function Write-BuildManifest([string]$pin, [string[]]$featureList, [string]$wasmOut, [string]$pkgDir, [string]$rustflags) {
    $manifestPath = Join-Path $pkgDir "build-manifest.json"
    @{
        builtAt   = (Get-Date).ToString("o")
        rustc     = (& rustup run $pin rustc -V)
        rustflags = $rustflags
        features  = ($featureList -join ",")
        wasmBytes = (Get-Item $wasmOut).Length
        sha256    = (Get-FileHash $wasmOut -Algorithm SHA256).Hash.ToLower()
    } | ConvertTo-Json | Set-Content $manifestPath
}

$featureCsv = $Features -join ','
$wasmBindgenVersion = Get-WasmBindgenVersion
$wasmBindgen = Resolve-WasmBindgenCli $wasmBindgenVersion
$wasmOptBin = Resolve-WasmOptBin

Write-Host "=== parallel-wasm: cargo +$nightly build ===" -ForegroundColor Cyan
Assert-RustupComponent $nightly "rust-src"

# SIMD already comes from .cargo/config.toml; keep script RUSTFLAGS focused on thread-required features.
$env:RUSTFLAGS = "-C target-feature=+atomics,+bulk-memory,+mutable-globals -C link-arg=--max-memory=4294967296"

Push-Location $repoRoot
try {
    & cargo "+$nightly" build `
        --lib `
        --target wasm32-unknown-unknown `
        --release `
        --locked `
        --features $featureCsv `
        -Z build-std=std,panic_abort

    if ($LASTEXITCODE -ne 0) { throw "cargo build failed" }

    $wasmIn = Join-Path $repoRoot "target\wasm32-unknown-unknown\release\raw_converter_wasm.wasm"
    Invoke-Bindgen $wasmBindgen $wasmIn $pkgDir

    $wasmOut = Join-Path $pkgDir "raw_converter_wasm_bg.wasm"
    if ($wasmOptBin) {
        Write-Host "=== wasm-opt (threads + bulk-mem + simd) ===" -ForegroundColor Cyan
        if (Test-Path $wasmOut) {
            Invoke-WasmOpt $wasmOptBin $wasmOut
        }
    } else {
        Write-Warning "wasm-opt not found in wasm-pack cache - shipping unoptimized wasm"
    }

    Write-BuildManifest $nightly $Features $wasmOut $pkgDir $env:RUSTFLAGS

    if (Test-Path $webPkgDir) { Remove-Item -Recurse -Force $webPkgDir }
    Copy-Item -Recurse -Force $pkgDir $webPkgDir

    $pkgHash = (Get-FileHash $wasmOut -Algorithm SHA256).Hash
    $webHash = (Get-FileHash (Join-Path $webPkgDir "raw_converter_wasm_bg.wasm") -Algorithm SHA256).Hash
    if ($pkgHash -ne $webHash) { throw "pkg and web/pkg wasm hashes diverged after copy" }

    Write-Host "=== done ===" -ForegroundColor Green
    Write-Host "Outputs: $pkgDir and $webPkgDir"
} finally {
    Pop-Location
    $env:RUSTFLAGS = $savedRustflags
    $env:PATH = $savedPath
}
