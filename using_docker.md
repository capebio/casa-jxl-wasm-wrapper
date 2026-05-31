# Using Docker and Emscripten

- Check Docker first with `docker info`. Docker CLI can be installed while the daemon is still unreachable.
- If Docker is unavailable but a local EMSDK exists, prefer a host-toolchain fallback instead of failing the root build.
- On Windows, resolve `EMSDK` explicitly when running `emcmake` / `em++`; do not assume the shell already has the right path.
- Keep the Docker image toolchain-only. Mount the repo and run the real build inside the container with a dedicated `--inside-docker` path.
- Treat a long Emscripten build as separate from daemon reachability. First confirm the daemon works, then wait on the compile.

## Windows: Docker Desktop daemon drops after a few seconds (named pipe disappears)

This is a common failure mode on Windows Insider builds + WSL2 when Docker Desktop's integration with your default WSL distro (often named "Ubuntu") is slow to boot. The API pipe (`dockerDesktopLinuxEngine`) appears briefly then vanishes, causing `docker run` / long builds to fail even though processes are running.

### Reliable one-shot launch + build (the pattern that worked)

Run the entire sequence in **one PowerShell session** so there is zero gap between the daemon becoming healthy and starting the heavy build:

```powershell
# Kill everything + clean WSL slate
$procs = @("Docker Desktop", "com.docker.backend", "com.docker.build", "docker-agent", "docker-sandbox")
Get-Process -Name $procs -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
wsl --shutdown
Start-Sleep -Seconds 3

# Launch Docker Desktop (minimized)
Start-Process "C:\Program Files\Docker\Docker\Docker Desktop.exe" -WindowStyle Minimized

# Poll until the daemon is actually responsive (adjust timeout as needed)
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

# IMPORTANT: immediately chain the real build command with no gap
Set-Location "C:\Foo\raw-converter-wasm"
node packages/jxl-wasm/scripts/build.mjs          # or your "tb"/tauribuild wrapper
```

This chained approach (launch → tight poll for `docker info` success → immediate build in the same process) is what allowed the full ~42-minute Emscripten Docker build to complete when separate commands kept losing the daemon.

### Longer-term mitigation

Once Docker Desktop is running and the Dashboard is responsive:
- Settings → Resources → WSL integration
- Uncheck your slow default distro (usually "Ubuntu")
- Restart Docker Desktop

This removes the integration timeout that was killing the startup on this machine. You can still use Docker normally; the `docker-desktop` distro used by the engine itself stays enabled.

If you rarely need Docker, the `--host-toolchain` fallback (local EMSDK) remains the fastest way to iterate on the WASM bridge when the Docker path is painful.
