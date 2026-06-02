# build-parallel-wasm.ps1
# Builds raw-converter-wasm with --features parallel-wasm (rayon thread pool).
#
# Prerequisites (one-time):
#   rustup toolchain install nightly --target wasm32-unknown-unknown
#   rustup component add rust-src --toolchain nightly
#
# Usage:
#   .\build-parallel-wasm.ps1

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot  = $PSScriptRoot
$wasmBindgen = "$env:LOCALAPPDATA\.wasm-pack\wasm-bindgen-89b59d2b2244e737\wasm-bindgen.exe"
$outDir    = Join-Path $repoRoot "web\pkg"

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
    Write-Host "=== wasm-bindgen ===" -ForegroundColor Cyan
    & $wasmBindgen $wasmIn --out-dir $outDir --target web --no-typescript

    if ($LASTEXITCODE -ne 0) { throw "wasm-bindgen failed" }

    # wasm-opt is bundled in wasm-pack; try to find it or skip.
    $wasmOpt = "$env:LOCALAPPDATA\.wasm-pack\wasm-opt-cdcb9e877b68d02e\bin\wasm-opt.exe"
    $wasmOptBin = Get-Item $wasmOpt -ErrorAction SilentlyContinue
    if ($wasmOptBin) {
        $wasmOut = Join-Path $outDir "raw_converter_wasm_bg.wasm"
        Write-Host "=== wasm-opt ===" -ForegroundColor Cyan
        & $wasmOptBin $wasmOut -O2 --enable-threads --enable-bulk-memory -o $wasmOut
    } else {
        Write-Host "wasm-opt not found in wasm-pack cache — skipping optimisation" -ForegroundColor Yellow
    }

    Write-Host "=== done ===" -ForegroundColor Green
    Write-Host "Output: $outDir"
} finally {
    Pop-Location
    $env:RUSTFLAGS = ""
}
