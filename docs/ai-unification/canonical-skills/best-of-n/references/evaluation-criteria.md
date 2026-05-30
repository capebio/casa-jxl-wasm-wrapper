# Best-of-N Evaluation Criteria (Detailed Rubric)

## Correctness (Weight: Primary)

**Strong PASS signals:**
- All explicit requirements in the task description are met.
- Implicit requirements that any competent implementer would understand are handled.
- Edge cases that are obvious from the domain are covered.

**FAIL signals:**
- Task is only partially implemented.
- Core user flow is broken or missing.
- The implementation would not pass a basic manual test of the stated goal.

**Example:**
Task: "Add rate limiting to the login endpoint"
- Correct: Implements a working limiter with reasonable defaults, tests, and integration.
- Incorrect: Adds a comment saying "rate limit here later" or implements it only for one path.

## Code Quality (Weight: Secondary, tie-breaker)

Look for:
- Consistent naming and structure with surrounding code.
- Appropriate use of existing utilities instead of reinventing.
- Reasonable comments where complexity warrants them.
- No gratuitous cleverness or over-abstraction.

## Safety (Weight: Important filter)

Automatic deductions for:
- Changes outside the stated scope that could break unrelated features.
- Introduction of new security surface (e.g., new unauthenticated endpoints, unsafe deserialization).
- Removal or weakening of existing guards without justification.

## Using the Graph During Evaluation

When candidates modify existing code:
- Run impact analysis on the files each candidate touched.
- Note which candidates minimized blast radius while still solving the problem.
- Candidates that touch many more modules than necessary for the same outcome lose points on both Correctness (they did extra work) and Safety.

Document these findings in your comparison.