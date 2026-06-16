$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$hookScript = Join-Path $repoRoot "tools\rtk-codex-hook.ps1"
if (-not (Test-Path -LiteralPath $hookScript)) {
    throw "Missing hook shim: $hookScript"
}

$codexDir = Join-Path $HOME ".codex"
$hooksPath = Join-Path $codexDir "hooks.json"
if (-not (Test-Path -LiteralPath $codexDir)) {
    New-Item -ItemType Directory -Path $codexDir | Out-Null
}

if (Test-Path -LiteralPath $hooksPath) {
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    Copy-Item -LiteralPath $hooksPath -Destination "$hooksPath.$stamp.bak"
}

$escapedHookScript = $hookScript.Replace("\", "\\")
$json = @"
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "powershell -NoProfile -ExecutionPolicy Bypass -File $escapedHookScript"
          }
        ]
      }
    ]
  }
}
"@

[System.IO.File]::WriteAllText($hooksPath, $json, [System.Text.UTF8Encoding]::new($false))

$bytes = [System.IO.File]::ReadAllBytes($hooksPath)
if ($bytes.Length -lt 1 -or $bytes[0] -ne 0x7B) {
    throw "hooks.json first byte is not '{'; encoding/write failed"
}

$probeInput = @{ hook_event_name = "PreToolUse"; tool_name = "Bash"; tool_input = @{ command = "rg foo" } } | ConvertTo-Json -Compress
$probeOutput = $probeInput | powershell -NoProfile -ExecutionPolicy Bypass -File $hookScript
$probe = $probeOutput | ConvertFrom-Json

if ($probe.hookSpecificOutput.permissionDecision -ne "allow") {
    throw "Probe failed: missing permissionDecision=allow"
}
if ($probe.hookSpecificOutput.updatedInput.command -ne "rtk grep foo") {
    throw "Probe failed: expected command rewrite to rtk grep foo"
}

Write-Host "Installed Codex PreToolUse hook:"
Write-Host "  $hooksPath"
Write-Host "Backups kept as hooks.json.*.bak"
Write-Host "Restart Codex, then approve changed hook trust."
