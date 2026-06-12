$ErrorActionPreference = "Stop"

try {
    $inputText = [Console]::In.ReadToEnd()
} catch {
    $inputText = ""
}
if (-not $inputText) {
    $inputText = (($input | ForEach-Object { [string]$_ }) -join [Environment]::NewLine)
}
$rtk = $env:RTK_BIN
if (-not $rtk) {
    $rtk = Join-Path $HOME ".rtk\rtk.exe"
}

try {
    $tmp = [System.IO.Path]::GetTempFileName()
    [System.IO.File]::WriteAllText($tmp, $inputText + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))
    $psi = [System.Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = "$env:ComSpec"
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true
    $psi.Arguments = "/d /s /c """"$rtk"" hook claude < ""$tmp"""""

    $proc = [System.Diagnostics.Process]::Start($psi)
    $raw = $proc.StandardOutput.ReadToEnd()
    $err = $proc.StandardError.ReadToEnd()
    $proc.WaitForExit()
    Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
    if ($env:RTK_CODEX_HOOK_DEBUG) {
        Write-Host "DEBUG rtkExit=$($proc.ExitCode) stderr=[$err]"
    }
    if ($proc.ExitCode -ne 0) { exit 0 }
} catch {
    if ($env:RTK_CODEX_HOOK_DEBUG) {
        Write-Host "DEBUG spawnError=$($_.Exception.Message)"
    }
    exit 0
}

$out = ($raw.Trim())
if ($env:RTK_CODEX_HOOK_DEBUG) {
    Write-Host "DEBUG inputLen=$($inputText.Length) input=[$inputText] raw=[$out]"
}
if (-not $out) { exit 0 }

try {
    $obj = $out | ConvertFrom-Json
} catch {
    exit 0
}

$emit = $false

if ($obj.PSObject.Properties.Name -contains "hookSpecificOutput") {
    $hso = $obj.hookSpecificOutput
    if ($hso -and ($hso.PSObject.Properties.Name -contains "updatedInput")) {
        $hso | Add-Member -NotePropertyName "permissionDecision" -NotePropertyValue "allow" -Force
        if (-not ($hso.PSObject.Properties.Name -contains "permissionDecisionReason")) {
            $hso | Add-Member -NotePropertyName "permissionDecisionReason" -NotePropertyValue "RTK auto-rewrite (codex shim)" -Force
        }
        $emit = $true
    }
} elseif ($obj.PSObject.Properties.Name -contains "updatedInput") {
    $obj | Add-Member -NotePropertyName "permissionDecision" -NotePropertyValue "allow" -Force
    if (-not ($obj.PSObject.Properties.Name -contains "permissionDecisionReason")) {
        $obj | Add-Member -NotePropertyName "permissionDecisionReason" -NotePropertyValue "RTK auto-rewrite (codex shim)" -Force
    }
    $emit = $true
}

if ($emit) {
    $obj | ConvertTo-Json -Depth 100 -Compress
} elseif ($env:RTK_CODEX_HOOK_DEBUG) {
    Write-Host "DEBUG emit=false props=$($obj.PSObject.Properties.Name -join ',')"
}
