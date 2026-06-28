# build-paint-probe.ps1 — build + run the native progressive paint-target probe
# against the in-repo external/libjxl-012 (validates JxlDecoderSetProgressivePaintTarget
# without any WASM rebuild). Requires the native libjxl-012 ninja build to exist.
#
#   pwsh tools/build-paint-probe.ps1 <input.jxl> [reps]
#
# The input must be a VarDCT, NO-extra-channel (no alpha!) JXL encoded with
# multiple AC passes (cjxl --progressive_ac), otherwise libjxl emits no
# JXL_DEC_FRAME_PROGRESSION events and the probe shows 0 paints.

param(
  [string]$Input = "$env:TEMP\mp_ac_only.jxl",
  [int]$Reps = 6
)

$ErrorActionPreference = "Stop"
$vcvars = "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat"
$repo   = "C:\Foo\raw-converter-wasm"
$build  = "C:\Users\User\AppData\Local\Temp\libjxl012-build"   # native libjxl-012 ninja build
$env:PATH = "C:\Program Files\LLVM\bin;$env:PATH"

if (-not (Test-Path "$build\lib\jxl.lib")) {
  throw "Native libjxl-012 build not found at $build. Build it first (ninja djxl) or repoint `$build."
}

# Ensure the decoder lib reflects the current source (recompiles changed TUs only).
cmd /c "call `"$vcvars`" >nul 2>&1 && ninja -C `"$build`" jxl" | Out-Null

$inc1 = "$repo\external\libjxl-012\lib\include"
$inc2 = "$build\lib\include"
$src  = "$repo\tools\paint_target_probe.cc"
$exe  = "$env:TEMP\paint_probe.exe"
$compile = "call `"$vcvars`" >nul 2>&1 && clang-cl /std:c++17 /EHsc /O2 /nologo /D_CRT_SECURE_NO_WARNINGS `"$src`" /I`"$inc1`" /I`"$inc2`" /Fe`"$exe`" /link /LIBPATH:`"$build\lib`" jxl.lib"
cmd /c $compile
if ($LASTEXITCODE -ne 0) { throw "probe compile failed" }

$dllDirs = (Get-ChildItem -Path $build -Recurse -Filter *.dll -ErrorAction SilentlyContinue | Select-Object -ExpandProperty DirectoryName -Unique)
$env:PATH = ($dllDirs -join ';') + ';' + $env:PATH
& $exe $Input $Reps
