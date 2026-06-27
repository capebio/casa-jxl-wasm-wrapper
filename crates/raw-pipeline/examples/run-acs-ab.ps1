# Interleaved A/B driver for acs_effort_bench (flipflop methodology at process granularity).
#
# Runs baseline.exe and variant.exe alternately with start-rotation across rounds
# to cancel thermal drift, takes the MIN per build (most drift-robust), reports
# %delta against the 2% gate, and byte-compares the dumped .jxl (decision-ordering test).
#
# Usage:
#   run-acs-ab.ps1 -Baseline <exe> -Variant <exe> -Ppm <ppm> -Efforts 7,9 -Rounds 6 -Reps 4
param(
  [Parameter(Mandatory)] [string]$Baseline,
  [Parameter(Mandatory)] [string]$Variant,
  [Parameter(Mandatory)] [string]$Ppm,
  [int[]]$Efforts = @(7, 9),
  [int]$Rounds = 6,
  [int]$Reps = 4,
  [int]$Warmup = 3,
  [int]$CropW = 1920,
  [int]$CropH = 1280
)

function Invoke-Bench($exe, $effort, $reps, $out) {
  $line = & $exe $Ppm $effort $reps $out $CropW $CropH $Warmup 2>$null | Where-Object { $_ -match '^RESULT' }
  if ($line -match 'min=([0-9.]+)\s+med=([0-9.]+)\s+size=(\d+)') {
    return [pscustomobject]@{ Min = [double]$Matches[1]; Med = [double]$Matches[2]; Size = [int]$Matches[3] }
  }
  throw "no RESULT from $exe e$effort"
}

foreach ($e in $Efforts) {
  $bOut = "C:\Tmp\acs_base_e$e.jxl"
  $vOut = "C:\Tmp\acs_var_e$e.jxl"
  $bMins = @(); $vMins = @(); $bSize = 0; $vSize = 0
  for ($r = 0; $r -lt $Rounds; $r++) {
    # start-rotation: alternate which build runs first each round
    if ($r % 2 -eq 0) {
      $b = Invoke-Bench $Baseline $e $Reps $bOut; $v = Invoke-Bench $Variant $e $Reps $vOut
    } else {
      $v = Invoke-Bench $Variant $e $Reps $vOut; $b = Invoke-Bench $Baseline $e $Reps $bOut
    }
    $bMins += $b.Min; $vMins += $v.Min; $bSize = $b.Size; $vSize = $v.Size
    Write-Host ("  e{0} round {1}: base={2:N1}ms var={3:N1}ms" -f $e, $r, $b.Min, $v.Min)
  }
  $bMin = ($bMins | Measure-Object -Minimum).Minimum
  $vMin = ($vMins | Measure-Object -Minimum).Minimum
  $delta = ($bMin - $vMin) / $bMin * 100.0
  $bytesEq = $false
  if ((Test-Path $bOut) -and (Test-Path $vOut)) {
    $h1 = (Get-FileHash $bOut -Algorithm SHA256).Hash
    $h2 = (Get-FileHash $vOut -Algorithm SHA256).Hash
    $bytesEq = ($h1 -eq $h2)
  }
  $gate = if ($delta -ge 2.0) { "PASS(>=2%)" } elseif ($delta -le -2.0) { "REGRESS" } else { "neutral(<2%)" }
  Write-Host ""
  Write-Host ("=== effort $e ===")
  Write-Host ("  baseline min : {0:N2} ms  ({1} B)" -f $bMin, $bSize)
  Write-Host ("  variant  min : {0:N2} ms  ({1} B)" -f $vMin, $vSize)
  Write-Host ("  speedup      : {0:N2}%   [{1}]" -f $delta, $gate)
  Write-Host ("  byte-exact   : {0}  (size {1} vs {2})" -f $bytesEq, $bSize, $vSize)
  Write-Host ""
}
