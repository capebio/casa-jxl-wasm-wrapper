param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$CargoArgs = @("check")
)

$vcvars = "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat"
$llvmBin = "C:\Program Files\LLVM\bin"

if (-not (Test-Path $vcvars)) {
    throw "Missing vcvars64.bat at $vcvars"
}

if (-not (Test-Path "$llvmBin\clang-cl.exe")) {
    throw "Missing clang-cl.exe at $llvmBin"
}

$env:PATH = "$llvmBin;$env:PATH"
$env:LLVMInstallDir = "C:\Program Files\LLVM"
$env:LLVMToolsVersion = "22"
$env:CARGO_TARGET_DIR = "C:\Tmp\raw-converter-wasm-msvc-target"

$quotedArgs = $CargoArgs | ForEach-Object {
    if ($_ -match '[\s"]') {
        '"' + ($_ -replace '"', '\"') + '"'
    } else {
        $_
    }
}
$argLine = [string]::Join(" ", $quotedArgs)
$cmd = "call `"$vcvars`" >nul && cargo +stable-x86_64-pc-windows-msvc $argLine"

cmd /c $cmd
exit $LASTEXITCODE
