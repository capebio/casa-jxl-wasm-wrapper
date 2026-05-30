---
name: autoclear
description: >
  After completing a discrete, self-contained section of work (with explicit success criteria and verification passed), automatically trigger a full context reset by spawning the next section in a brand new terminal tab/window running a fresh Grok instance.
  The agent generates a tab title that **starts with the section number (no leading zero) followed immediately by a hyphen** and then a descriptive name (e.g. "3-Refactor Auth Module", "4-Implement Payment Flow"), writes a rich handoff file, and launches the continuation in a new tab so the workflow can flow without manual /clear.
  Use for long multi-section agent workflows (Epic reviews, phased implementations, etc.) where you want clean context between phases and organized tabs.
  Trigger phrases: "autoclear", "clear after this section and continue", "full reset and spawn next", "/autoclear".

version: "0.3.0-canonical"
canonical-id: "grand-unification:meta:autoclear:2026-05"

when-to-use: |
  - "autoclear after this section"
  - "clear the context and continue in a new tab"
  - "spawn next section with clean context"
  - "/autoclear"
  - Any multi-section workflow where you want the agent to handle resets + nice tab naming automatically

argument-hint: "[section name] [--no-spawn]"

surfaces:
  - grok

tags:
  - meta
  - session-management
  - long-running-workflows
  - unification
  - automation
  - windows-terminal

categories:
  - workflow
  - meta

verification-criteria:
  - "A rich handoff file is written to %TEMP% before spawning"
  - "The agent generates a short, useful tab_title / section label"
  - "The agent attempts to spawn the next section using wt (preferred) or start, with the chosen title"
  - "The new instance is given the handoff file path and clear instructions to continue"
  - "The agent in the current session stops after launching the continuation"

references:
  - path: references/handoff-template.md
    purpose: "Standard rich handoff format including tab_title"
  - path: references/spawning-strategies.md
    purpose: "PowerShell + Windows Terminal specific spawning commands with tab naming"

license: Personal
last-unified: "2026-05-30"
changelog:
  - "0.3.0-canonical: Tab titles now strictly use N-Description format (number + hyphen, no padding) so truncation reliably shows the sequence number (e.g. '3-Refa...' instead of '3 - c')."
  - "0.2.0-canonical: Agent now spawns fresh Grok process for true flowing autoclear."
  - "0.1.0-canonical: Initial marker-based version."

metadata:
  grok:
    can_spawn_new_processes: true
    prefers_windows_terminal_tabs: true
    requires_user_to_close_old_window: false   # with good tab naming you can just switch
---

# Autoclear — Agent-Driven Fresh Session + Nice Tab Naming

The goal is **flow with organization**: finish a section cleanly, have the agent open a new tab with a title that starts with the number immediately followed by a hyphen (e.g. "4-Payment Flow Phase 3"), seed it with the handoff, and continue working in a completely fresh context.

This is the closest we can get to the agent performing its own `/clear` while keeping the overall workflow moving.

## Core Behavior

When a section is complete:

1. Verify the section (strongly prefer `check-work`).
2. Generate a short, human-readable **tab_title** / section label (you can guide it with `--naming-theme`).
3. Write a rich handoff file to `%TEMP%`.
4. Use the best available method (Windows Terminal `wt new-tab --title "..."` preferred) to open a fresh Grok instance in a new tab/window, passing the handoff.
5. Stop in the current tab. The work continues cleanly in the new one.

## Tab Naming (The Part You Care About)

The agent **must** generate tab titles in this exact format:

**N-Short Descriptive Name**

Examples of good titles:
- `3-Refactor Authentication Module`
- `4-Add Payment Flow Validation`
- `5-Epic Section 7 UX Audit`

Why this format?
- Number immediately followed by a hyphen (no leading zero, no spaces) means that even when Windows Terminal truncates the tab title, you still clearly see the sequence (e.g. "3-Refa..." or "4-Add P..." instead of something like "3 - c").
- It makes it obvious these are sequential/child tabs of the same long-running task.
- The rest is kept descriptive and reasonably short.

The agent is responsible for maintaining the section counter (via handoff files in %TEMP% or your todo list). Use the actual number with no padding.

## Detailed Steps the Agent Must Follow

### Step 1: Verify Completion
Run verification on the current section only.

### Step 2: Choose a Tab Title + Write Handoff
- Decide on a good `tab_title` (respect any `--naming-theme` you passed earlier).
- Write the handoff to: `$env:TEMP\autoclear-handoff-<slug>.md` (use the tab_title to make the slug).
- The handoff must include the tab_title so the new instance knows what it's called.

Use the template in `references/handoff-template.md`.

### Step 3: Spawn the Fresh Instance

**Preferred (Windows Terminal - best tab naming):**

```powershell
$title = "4-Refactor Authentication Module"
$handoff = "$env:TEMP\autoclear-handoff-4-Refactor-Auth-Module.md"

wt -w 0 new-tab --title $title `
    pwsh -NoExit -Command "& 'C:\Users\User\.grok\bin\grok.exe' -p @'
AUTOCLEAR HANDOFF RECEIVED.

Tab title: $title
Handoff file: $handoff

Read the handoff first, then begin the next section.
'@"
```

**Fallback (plain console):**

```powershell
start $title "C:\Users\User\.grok\bin\grok.exe" -p "Read handoff at: $handoff and continue."
```

See `references/spawning-strategies.md` for more variants and PowerShell helpers.

### Step 4: Announce & Stop
Tell the user something like:
"I've finished Section 3. Launched new tab '4-Refactor Authentication Module' with the complete handoff. You can switch to it now."

Then stop.

## Flags

- `autoclear --no-spawn` → Just produce the handoff + marker and stop (no new tab). Useful for manual control.
- The agent must always use the `N-Description` format (number + hyphen, no padding).

## Why This Works Well for PowerShell + Windows Terminal Users

- `wt new-tab --title "..."` gives you clean, named tabs in your existing Windows Terminal window.
- Each tab is a truly fresh Grok session.
- You can keep many sections open side-by-side with clearly sequenced tab names where the number is always visible at the start even when truncated (e.g. "4-Refa...").
- The handoff lives on disk, so even if the prompt is truncated, the new agent has the full details.

This turns long agent runs into a series of well-organized, clean-context tabs instead of one ever-growing polluted session.

## Limitations

- You will have multiple Grok tabs/windows open (this is usually a feature, not a bug, for long work).
- The old tab is left behind (you can close it when you're sure the new one has everything).

Combine this with `todo_write` across tabs for best results. The handoff should include the current todo state.