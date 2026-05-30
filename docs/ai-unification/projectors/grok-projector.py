#!/usr/bin/env python3
"""
Grok Projector (v0.1 stub) — Grand Unification

Takes a canonical skill directory and emits a native Grok SKILL.md
in the requested scope (project or user).

This is intentionally simple for P0. Real version should:
- Do proper YAML frontmatter parsing + selective field mapping
- Handle argument-hint / arguments translation
- Copy references/ and scripts/ with correct relative paths
- Trigger Grok skill reload hint
"""

import argparse
import shutil
from pathlib import Path
import sys

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("canonical_dir", help="Path to canonical skill dir (containing SKILL.md)")
    parser.add_argument("--scope", choices=["project", "user"], default="project")
    parser.add_argument("--output-root", help="Override output root (default: auto-detect)")
    args = parser.parse_args()

    src = Path(args.canonical_dir).resolve()
    skill_md = src / "SKILL.md"
    if not skill_md.exists():
        print(f"ERROR: No SKILL.md found in {src}")
        sys.exit(1)

    # Very naive for now: just copy the canonical SKILL.md as-is
    # (it is already written to be usable on Grok because we used enriched frontmatter)
    name = None
    for line in skill_md.read_text(encoding="utf-8").splitlines():
        if line.strip().startswith("name:"):
            name = line.split(":", 1)[1].strip()
            break
    if not name:
        print("ERROR: Could not parse name from frontmatter")
        sys.exit(1)

    if args.output_root:
        root = Path(args.output_root)
    else:
        if args.scope == "project":
            # Walk up to find .git or assume cwd
            root = Path.cwd()
            while root != root.parent and not (root / ".git").exists():
                root = root.parent
            root = root / ".grok" / "skills"
        else:
            root = Path.home() / ".grok" / "skills"

    dest_dir = root / name
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest_md = dest_dir / "SKILL.md"

    shutil.copy2(skill_md, dest_md)

    # Copy references and scripts if present
    for sub in ("references", "scripts"):
        sub_src = src / sub
        if sub_src.exists():
            sub_dest = dest_dir / sub
            if sub_dest.exists():
                shutil.rmtree(sub_dest)
            shutil.copytree(sub_src, sub_dest)

    print(f"Projected -> {dest_md}")
    print(f"  (scope={args.scope})")
    print("Run `/skills` or restart Grok TUI to pick up the new skill.")

if __name__ == "__main__":
    main()
