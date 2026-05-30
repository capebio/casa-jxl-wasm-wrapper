#!/usr/bin/env python3
"""
Minimal structural validator for canonical skills (v0.1).

Checks presence of required frontmatter fields and basic layout.
This is a stub — expand with real schema validation (jsonschema or PyYAML) later.
"""

import sys
from pathlib import Path

def main(skill_dir: str):
    p = Path(skill_dir)
    skill_md = p / "SKILL.md"
    if not skill_md.exists():
        print("FAIL: SKILL.md not found")
        return 1

    content = skill_md.read_text(encoding="utf-8")
    required = ["name:", "description:"]
    missing = [f for f in required if f not in content.split("---", 2)[1]]
    if missing:
        print(f"FAIL: Missing required frontmatter fields: {missing}")
        return 1

    print("OK (basic structure looks plausible)")
    return 0

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: validate-skill-structure.py <path-to-skill-dir>")
        sys.exit(2)
    sys.exit(main(sys.argv[1]))
