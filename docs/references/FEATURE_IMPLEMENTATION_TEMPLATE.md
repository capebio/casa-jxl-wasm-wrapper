# Feature Implementation Template for CasaWASM + Tauri

**Purpose**  
This template defines the exact process the agent must follow when implementing any new JPEG XL feature. It ensures consistent quality, cross-platform coordination (WASM ↔ Tauri), proper git hygiene, good handoff practices, benchmark integration, and rigorous cleanup.

**Related:** See `designs/DESIGNS_INDEX.md` for the current list of design notes. Each implementation should start from the checklist at the bottom of the relevant design note.

---

## Mandatory Process Rules (Read These Every Time)

1. **Branching** — At the very start of work on a feature (or major section of a feature), create and switch to a new, appropriately named git branch.
   - Naming convention example: `feature/<short-kebab-name>` (e.g., `feature/modular-predictor-control`, `feature/photon-noise`, `feature/extra-channel-distance`).
   - Do this before writing any code or making changes.

2. **Handoff on Issues** — If you run into blockers, unexpected complexity, or need to pause, immediately produce a clear **Handoff Document** (see section below). Do not leave the state unclear.

3. **Benchmark Wiring** — Every feature that introduces new toggles, options, or controls **must** result in UI exposure in the Benchmark pages.
   - Preferred: Integrate into an existing relevant page (`jxl-wrapper-lab.js`, `jxl-progressive-paint.html`, `jxl-crop-benchmark.html`, etc.).
   - Alternative: Create a small focused new page or tab if it doesn't fit cleanly.
   - The goal is to make the new capability immediately testable and demonstrable.

4. **Cleanup & Handoff Discipline** — Every feature (or major section) **must end** with a standardized Cleanup & Handoff block (pattern taken from `_cleanup_source.md` in this folder). This includes:
   - Clear "Current State" summary.
   - Any long-running or detached processes must use file-backed logs.
   - Instructions for the next session / agent.
   - Recommendation to clear context and start fresh from repo root after appropriate clean commands.

---

## 0. Preparation (Always Do This First)

1. Read the latest:
   - `CasaWASM_JXL_Feature_Completeness_and_Gaps.md`
   - `references/REFERENCE_INDEX.md`

2. Create/switch to the feature branch (see rule #1 above).

3. Locate the feature in the REFERENCE_INDEX and fetch the relevant reference code sections.

---

## 1–8. [Existing sections on Research, Design, Implementation Order, Testing, API Design, Documentation, Rust vs C++, Checklist remain here — agent should follow them]

*(The body of the previous template stays in place. The new mandatory rules above take precedence and must be applied on top of the existing guidance.)*

---

## 9. Benchmark Integration (Mandatory Deliverable)

As part of completing the feature:

- Identify the most appropriate existing Benchmark page or create a minimal new one.
- Wire the new toggle/option/control so it is usable in the UI.
- Add at least basic visual + timing feedback so the effect of the new setting is observable.
- Update any relevant documentation or help text in the page.

This step is not optional. Features without benchmark exposure are considered incomplete.

---

## 10. Cleanup & Handoff (End of Every Feature / Major Section)

At the end of the work (or when handing off), produce output that follows this pattern (adapted from the project's `_cleanup_source.md`):

### Current State
- [Concise bullet list of what was implemented, which files were changed, tests added, docs updated, benchmark wiring done]
- Branch name: `feature/xxx`
- Any background / detached processes started (with log file locations)
- Open questions or known limitations

### What to do before the next fresh run / next agent session
- Clear the chat / agent context.
- Check for any detached long-running processes or builds.
- Start the next session from the repo root.
- Run any required clean commands (e.g., after `/clean` or equivalent).

### Recommended commands (if watching background work)
- [Any `Get-Content` tail commands for log files, or equivalent]

### Notes
- Any important context, decisions, or gotchas discovered during implementation.
- Link to any handoff document if one was created.

---

## Handoff Protocol (When Issues Arise)

If you cannot complete the feature in the current session or encounter a significant blocker:

1. Stop at a clean point.
2. Produce a dedicated **Handoff Document** (can be a new `.md` file or a clear section).
3. The handoff must contain at minimum:
   - Current branch
   - What was attempted
   - What succeeded and what failed
   - Exact reproduction steps for the problem
   - Suggested next steps or questions for the next agent
   - Any temporary workarounds or notes

Do not leave the repository in a broken or unclear state.

---

## Quick Checklist (Updated)

- [ ] New feature branch created with good name at the very start
- [ ] Research & comparison using REFERENCE_INDEX completed
- [ ] Design done for both WASM and Tauri (consistency considered)
- [ ] Implementation (WASM then Tauri recommended)
- [ ] Tests added / updated
- [ ] Benchmark page wired (new or existing)
- [ ] All tracking documents updated (Gaps, Reference Index, etc.)
- [ ] Full Cleanup & Handoff block written following the pattern above
- [ ] Handoff document created if any issues/blockers remain

---

This template, combined with the REFERENCE_INDEX, is now the authoritative process for all future feature work on the CasaWASM + Tauri JXL effort.
---

## 11. Recommended Workflow for Research + Synthesis (Critical Efficiency Decision)

When tackling a new feature, there are two viable ways to use the references:

### Option A: Agent does full aggregation every time (not recommended for scale)
- Agent reads all relevant reference sections for the feature.
- Agent synthesizes the best approach.
- This works for 1-2 features but becomes very token-heavy and slow when doing dozens of features.

### Option B: Grok does the heavy synthesis once per feature (Recommended)

**This is the preferred model going forward.**

For each feature:

1. **Grok (me) performs the research aggregation**:
   - Uses the REFERENCE_INDEX.md to pull the most relevant code sections from the key references (especially cjxl_main.cc, jpegxl-rs, chafey, libvips, and official headers/examples).
   - Analyzes the differences in approach, trade-offs, and patterns.
   - Produces a **Feature Design Note** (saved in eferences/designs/Feature-Name.md).
   - The design note includes:
     - Summary of how each major reference handles the feature.
     - Key differences and why they matter.
     - Recommended design for CasaWASM (bridge + facade).
     - Recommended design for Tauri (Rust via jpegxl-rs/sys).
     - Suggested file locations and high-level code structure.
     - Any open questions or risks.

2. **The design note becomes the source of truth** for that feature.

3. **The implementing agent** then follows the rest of this template:
   - Creates the git branch.
   - Implements according to the design note (with autonomy to improve on details).
   - Wires the benchmark UI.
   - Writes tests.
   - Produces the Cleanup & Handoff + appends to PROGRESS_LOG.md.

**Benefits of Option B**:
- Much more efficient token usage across many features.
- Consistent high-quality analysis (I'm good at cross-referencing large amounts of code).
- Creates a growing library of excellent design documents that become more valuable over time.
- The agent still has autonomy on implementation details and can question the proposal.

**When to use more autonomy (Option A style)**:
- Very simple or obvious features.
- When the agent has already done deep work on similar features.

**Default going forward**: Use Option B unless explicitly told otherwise for a specific feature.

---

## 12. Per-Feature Design Notes Convention

All design proposals from Grok will be saved as:
eferences/designs/<kebab-feature-name>.md

These notes should be treated as living documents. The implementing agent is encouraged to add notes, decisions made during implementation, and deviations from the original proposal (with rationale).

This creates an excellent audit trail and knowledge base for the whole project.

