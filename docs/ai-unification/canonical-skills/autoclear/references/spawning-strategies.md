# Autoclear Spawning Strategies (PowerShell + Windows Terminal Focused)

## Recommended: Windows Terminal with Named Tabs (Best Experience)

```powershell
$title = "04 - Refactor Authentication Module"
$handoffPath = "$env:TEMP\autoclear-handoff-04-Refactor-Auth-Module.md"

wt -w 0 new-tab --title $title `
    pwsh -NoExit -Command "& 'C:\Users\User\.grok\bin\grok.exe' -p @'
AUTOCLEAR HANDOFF RECEIVED.

Tab title: $title
Handoff file: $handoffPath

Read the complete handoff first, then proceed with the next section.
'@"
```

## Simple Fallback (new console window)

```powershell
$title = "04 - Refactor Authentication Module"
$handoffPath = "$env:TEMP\autoclear-handoff-04-Refactor-Auth-Module.md"

start $title "C:\Users\User\.grok\bin\grok.exe" -p "Read handoff at: $handoffPath and continue with the next section."
```

## Generating Good Names

The agent must produce titles in this strict format during autoclear:

**N-Short Descriptive Name**

Good examples:
- `3-Refactor Authentication Module`
- `4-Add Payment Flow Validation`
- `5-Epic Section 7 UX Audit`

The number comes first with **no leading zero** and is immediately followed by a hyphen (no spaces). This way, even heavy truncation in Windows Terminal still clearly shows the sequence number (e.g. "3-Refa..." instead of "3 - c").

The agent can track the current section number via its todo list or by inspecting previous handoff files in %TEMP%.

## Tips for PowerShell Users

- Put the spawning logic into a small helper function in your profile if you do this a lot.
- Using `wt new-tab --title` keeps everything inside one Windows Terminal window with nicely labeled tabs — this is usually the best workflow.
- The handoff file in `%TEMP%` survives across processes, which is why we prefer it over trying to stuff everything into the `-p` prompt.