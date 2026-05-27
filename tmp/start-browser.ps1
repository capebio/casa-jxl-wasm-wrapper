param(
    [Parameter(Mandatory = $true)]
    [string]$BrowserPath,
    [Parameter(Mandatory = $true)]
    [string]$UserDataDir,
    [Parameter(Mandatory = $true)]
    [int]$Port
)

$ErrorActionPreference = "Stop"

New-Item -ItemType Directory -Force -Path $UserDataDir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $PSScriptRoot "logs") | Out-Null
$stdout = Join-Path $PSScriptRoot ("logs/{0}.out.txt" -f $Port)
$stderr = Join-Path $PSScriptRoot ("logs/{0}.err.txt" -f $Port)
$extraArgs = @(
    "--disable-breakpad",
    "--disable-crash-reporter"
    "--disable-features=NetworkServiceSandbox"
)
$argsList = @(
    "--headless",
    "--no-sandbox",
    "--remote-debugging-port=$Port",
    "--user-data-dir=$UserDataDir",
    "about:blank"
 ) + $extraArgs
$proc = Start-Process -PassThru -WindowStyle Hidden -FilePath $BrowserPath -ArgumentList $argsList -RedirectStandardOutput $stdout -RedirectStandardError $stderr

Start-Sleep -Seconds 5
if ($proc.HasExited) {
    "exitcode=$($proc.ExitCode)"
    if (Test-Path $stdout) { Get-Content $stdout }
    if (Test-Path $stderr) { Get-Content $stderr }
    exit 1
}
try {
    Invoke-WebRequest "http://127.0.0.1:$Port/json/version" -UseBasicParsing | Select-Object -ExpandProperty Content
} catch {
    $_.Exception.Message
    if (Test-Path $stdout) { Get-Content $stdout }
    if (Test-Path $stderr) { Get-Content $stderr }
    exit 1
}
