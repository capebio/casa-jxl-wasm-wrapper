# Playwright Notes

Read this before trying browser automation in this repo.

Observed failure modes on this machine:

- `chromium.launch()` and `chromium.launchPersistentContext()` can fail with `spawn EPERM`
- `chrome-headless-shell.exe` can die immediately with `mojo::platform_channel.cc:108` `Access is denied`
- `chrome.exe` can hit Crashpad and `ProcessSingleton` access-denied errors
- CDP attach can succeed briefly, but the browser may close before a new page/context is created

What was already tried:

- Playwright direct launch
- persistent profile launch
- raw `spawn()` / `spawnSync()`
- `rtk proxy` launch paths
- PowerShell `Start-Process`
- `connectOverCDP()`

Current conclusion:

- Playwright browser automation is blocked by Windows process / sandbox / crashpad behavior in this environment
- Do not repeat the same launch variants without a new hypothesis
- Prefer unit tests or non-browser verification until the launcher issue changes
