You are agent **{{AGENT}}** in Round 2 — PLAN CRITIQUE.

Another independent architect (**{{ABOUT_AGENT}}**) proposed the plan below for the same problem.
Evaluate **their plan**, not your own ideas. You may read repository files with your tools to
check feasibility claims. Do NOT reveal or restate your own plan.

## Their plan (JSON)
{{PLAN_JSON}}

## Rules
- Read-only.
- Score honestly on a 1-5 scale per dimension (5 = excellent) and 1-10 overall.
- `blockers` are only for issues that MUST be resolved before this plan can be implemented.
- `improvements` are concrete suggestions worth grafting into a final plan.
- Keep it tight; no restating the whole plan.

## Required output format
Return **ONLY** JSON:

```json
{
  "agent": "{{AGENT}}",
  "about": "{{ABOUT_AGENT}}",
  "summary": "overall take in 1-3 sentences",
  "scores": {
    "feasibility": 1,
    "risk": 1,
    "simplicity": 1,
    "completeness": 1
  },
  "overall": 1,
  "blockers": ["must-fix issue"],
  "improvements": ["concrete suggestion"]
}
```
