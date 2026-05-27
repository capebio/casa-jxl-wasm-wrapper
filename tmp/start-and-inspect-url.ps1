param(
    [Parameter(Mandatory = $true)]
    [string]$BrowserPath,
    [Parameter(Mandatory = $true)]
    [string]$UserDataDir,
    [Parameter(Mandatory = $true)]
    [int]$Port,
    [Parameter(Mandatory = $true)]
    [string]$Url
)

$ErrorActionPreference = "Stop"

New-Item -ItemType Directory -Force -Path $UserDataDir | Out-Null
$argsList = @(
    "--headless=new",
    "--no-sandbox",
    "--remote-debugging-port=$Port",
    "--user-data-dir=$UserDataDir",
    "--disable-breakpad",
    "--disable-crash-reporter",
    "--disable-features=NetworkServiceSandbox",
    $Url
)

Start-Process -WindowStyle Hidden -FilePath $BrowserPath -ArgumentList $argsList | Out-Null

$deadline = (Get-Date).AddSeconds(15)
while ((Get-Date) -lt $deadline) {
    try {
        $v = Invoke-WebRequest "http://127.0.0.1:$Port/json/version" -UseBasicParsing | Select-Object -ExpandProperty Content
        if ($v) { break }
    } catch {
        Start-Sleep -Milliseconds 250
    }
}

if (-not $v) {
    throw "CDP not ready on port $Port"
}

$env:CDP_PORT = "$Port"
node -e "const { chromium } = require('playwright'); (async () => { const browser = await chromium.connectOverCDP('http://127.0.0.1:' + process.env.CDP_PORT); console.log('contexts', browser.contexts().length); for (const [i, ctx] of browser.contexts().entries()) { console.log('ctx', i, 'pages', ctx.pages().length); if (ctx.pages().length) { console.log('title', await ctx.pages()[0].title()); } } await browser.close(); })().catch(err => { console.error(err.stack || err.message || String(err)); process.exit(1); });"
