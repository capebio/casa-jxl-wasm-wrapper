# Build + run the conv5 A/B harness against the worktree libjxl.
#   .\run-conv5-ab.ps1 fnv    -> FNV-1a per (target,config) byte-exact set
#   .\run-conv5-ab.ps1 slow   -> Separable5 vs SlowSeparable5 <=1e-5 (incl N/N+1)
#   .\run-conv5-ab.ps1 time   -> 1024x1024 timing
# Rebuilds jxl-internal incrementally first, so it picks up edits to
# enc_convolve_separable5.cc. OLD-vs-NEW: `git checkout <rev> -- <file>` then
# re-run; compare conv5_fnv_OLD.txt vs conv5_fnv_NEW.txt.
param([string]$Mode = "fnv")
$ErrorActionPreference = "Stop"
$vcvars = "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat"
$env:PATH = "C:\Program Files\LLVM\bin;$env:PATH"
$root = "C:\Foo\rcw-conv5edge\external\libjxl-012"
$b = "$root\build-ab"
$tools = "C:\Foo\rcw-conv5edge\tools"

$cc = "clang-cl /std:c++17 /O2 /EHsc /MD /DNDEBUG /nologo /wd4716 " +
  "/I $root /I $root\third_party\highway /I $root\lib\include /I $b\lib\include " +
  "$tools\conv5_ab.cc /Fe:$tools\conv5_ab.exe /Fo:$tools\conv5_ab.obj " +
  "/link /LIBPATH:$b\lib /LIBPATH:$b\third_party\highway jxl-internal.lib hwy.lib"

$build = "ninja -C `"$b`" jxl-internal && $cc"
# Build chatter -> log file so stdout carries only harness output (clean for redirection).
cmd /c "call `"$vcvars`" >nul 2>&1 && cd /d `"$root`" && $build" > "$tools\conv5_build.log" 2>&1
if ($LASTEXITCODE -ne 0) { Get-Content "$tools\conv5_build.log" -Tail 30; throw "build failed ($LASTEXITCODE)" }
& "$tools\conv5_ab.exe" $Mode
