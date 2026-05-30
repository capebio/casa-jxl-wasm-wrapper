# Owl Lenses — Core Perspectives

Use these systematically on every strategic review.

## 1. Near vs Far
- **Near**: Specific files, functions, lines, concrete behaviors, recent changes, exact error messages.
- **Far**: Incentives, architecture, feedback loops (or lack thereof), cultural patterns, maintenance tax, second-order effects.

Always do both. A review that only does one is incomplete.

## 2. Day vs Night
- **Day** (visible): Bugs, duplication, slow code, obvious missing features, current pain points.
- **Night** (hidden): Structural fragmentation, silent maintenance burden growth, verification debt, assumptions that will break when models improve, security surface that grows with capability.

Night vision is where the highest-leverage findings usually live.

## 3. Strengths (Protect These)
What is genuinely excellent and worth doubling down on?
- Verification culture
- Token economics discipline
- High-agency loops (Epic family)
- Dogfooding instinct
- etc.

Name them explicitly. The goal is not just criticism.

## 4. Deficiencies & Structural Problems
Where is the system fighting itself?
- Fragmentation across surfaces
- Missing observability / feedback loops
- "Cobbler's children" (the AI OS not using its own best tools)
- Drift between canonical intent and actual usage

## 5. Opportunities (Categorized)
- Efficiency / Speed (token, time, context lifetime)
- Features / Capability
- Maintainability & Predictability
- Predictive / Future-Proofing

## 6. Risks & Predictive Outlook (Mandatory)
- Short-term (0-6 months)
- Medium-term (6-18 months)
- What becomes obsolete or much easier as base models improve?
- What maintenance tax is growing faster than the value delivered?

This section separates good reviews from great ones.

## 7. Self-Reference (When Applicable)
When the target is the AI OS, skills, unification, or your own processes:
- Does the thing under review actually use the best patterns it advocates?
- Is the unification accelerating or just adding ceremony?
- Are the new canonical tools being dogfooded or just documented?

## Application Order (Recommended)

For most targets:
1. Frame + gather (use graph early)
2. Strengths (builds credibility and protects good things)
3. Deficiencies (night vision)
4. Opportunities
5. Predictive + Risks
6. Prioritized recommendations with sequencing

Adjust emphasis based on the ask (pure strategic vs focused on one subsystem).