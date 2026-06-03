$procs = "Docker Desktop", "com.docker.backend", "com.docker.build", "docker-agent", "docker-sandbox"
Get-Process -Name $procs -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
wsl --shutdown
Start-Sleep -Seconds 3

Start-Process "C:\Program Files\Docker\Docker\Docker Desktop.exe" -WindowStyle Minimized

$deadline = (Get-Date).AddSeconds(180)
$stable = $false
while ((Get-Date) -lt $deadline) {
    $ver = docker info --format '{{.ServerVersion}}' 2>&1
    if ($LASTEXITCODE -eq 0 -and $ver -match '^\d') {
        Write-Host "Docker STABLE: $ver" -ForegroundColor Green
        $stable = $true
        break
    }
    Start-Sleep -Seconds 4
}
if (-not $stable) { throw "Docker never stabilized" }

Set-Location "C:\Foo\raw-converter-wasm"
npm run build