# Build the jxl_encdec_ab harness against a given libjxl source dir (OLD/NEW),
# under the MSVC + LLVM toolchain, then copy the exe to a stable name.
# Usage: .\build-ab.ps1 <LIBJXL_SOURCE_DIR> <out_exe_path>
param([string]$Source, [string]$OutExe)

$vcvars = "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat"
$llvmBin = "C:\Program Files\LLVM\bin"
$here = "C:\Foo\rcw-verify"
$targetDir = "C:\Tmp\raw-converter-wasm-msvc-target"

$env:PATH = "$llvmBin;$env:PATH"
$env:LLVMInstallDir = "C:\Program Files\LLVM"
$env:LLVMToolsVersion = "22"
$env:LIBCLANG_PATH = "$llvmBin"
$env:CARGO_TARGET_DIR = $targetDir
$env:LIBJXL_SOURCE_DIR = $Source

$cmd = "call `"$vcvars`" >nul && cd /d `"$here`" && cargo +stable-x86_64-pc-windows-msvc build --release -p raw-pipeline --example jxl_encdec_ab"
cmd /c $cmd
if ($LASTEXITCODE -ne 0) { Write-Output "BUILD FAILED ($LASTEXITCODE) for $Source"; exit $LASTEXITCODE }

$built = "$targetDir\release\examples\jxl_encdec_ab.exe"
Copy-Item $built $OutExe -Force
Write-Output "OK -> $OutExe  (source=$Source)"
