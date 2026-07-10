---
description: 3-agent planning — independent plans, scored peer critique, ranked synthesis (no implementation)
argument-hint: "[--wait|--background] [--codex-model <id>] [--grok-model <id>] [--debate-rounds 0|1|2] [problem text]"
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), Write, AskUserQuestion
---

# Council plan

The council designs an approach to a problem: Claude + Codex + Grok each write an
independent plan, then score each other, and you synthesize a single ranked plan.
**This STOPS at the plan** — no writer, no diff. To also implement it, use
`/council:solve` (same protocol + one writer + a review of the result).

Raw arguments: `$ARGUMENTS`

## Protocol (follow exactly)

### Phase 0 — YOU (Claude): condense the problem
Clarify the problem from the user's text + repo context (read key files) and write it
to an OS temp file **outside the repo** (goal, constraints, relevant files/subsystems,
acceptance criteria), e.g. `$TMPDIR/council-problem.md`.

### Phase 1 — start the companion FIRST, then write your own plan (parallel)

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/council-companion.mjs" solve --problem-file "$TMPDIR/council-problem.md" --claude-plan-wait "$TMPDIR/council-claude-plan.json" --wait-timeout 600 --background $ARGUMENTS
```

While Codex + Grok plan (R1), write YOUR independent plan to
`$TMPDIR/council-claude-plan.json` (schema: `schemas/plan.schema.json`). Do NOT read
their plans first — the companion picks your file up automatically.

### Phase 2 — companion: cross-critique + ranking (automatic)
Each agent scores the other plans (feasibility/risk/simplicity/completeness 1-5,
overall 1-10) and lists blockers/improvements. Optional bounded debate on blockers
via `--debate-rounds 1|2`. The report ranks the plans with a score matrix.

### Phase 3 — YOU: synthesize and present
1. Take the best-ranked plan as the skeleton; graft the strongest improvements from the others.
2. Resolve or explicitly accept every blocker.
3. **Present the final plan to the user and STOP.** Do not implement. Offer
   `/council:solve` (implement it with one writer + review) as the next step.

## Rules
- Read-only throughout — no file edits, no branch, no writer.
- Never let an agent see the other plans before its own is written (independence).
- Prefer `--background` + `/council:status` for anything non-trivial.
