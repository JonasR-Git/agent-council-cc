---
description: Iterate review -> fix -> re-review until the council approves the diff (bounded rounds)
argument-hint: "[focus text]"
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Edit, Write, Bash(node:*), Bash(git:*), AskUserQuestion
---

# Council fix loop

Drive a change to council approval: review, fix the actionable findings, re-review,
repeat until >=2 agents approve or a hard round cap is hit. This productizes the
manual loop; you (Claude) are the writer and orchestrator.

Raw arguments (treat as optional **focus text only**): `$ARGUMENTS`

`$ARGUMENTS` is focus text for the review — it is NOT deliberate flags. Do not pass
`--max-rounds`/`--writer` to any command (deliberate rejects unknown flags). Those
are loop-level knobs you interpret yourself; default max rounds = 3, writer = claude.

## Preconditions
- Work on a dedicated branch with a clean tree (commit or stash first).
- Record the starting ref **once**: `BASE=$(git rev-parse HEAD)`. Keep BASE FIXED for
  every round, so each review sees the full cumulative diff and a late round cannot
  reintroduce an issue an earlier round fixed.

## Loop (max 3 rounds; then hand back to the user)

For round = 1..3:

1. **Review** the diff since BASE, writing your own R1 first. Pass ONLY the focus
   text (if any) as the positional — no loop flags:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/council-companion.mjs" deliberate --base "$BASE" \
     --claude-findings-wait "<ostemp>/fixloop-claude-r<round>.json" --wait-timeout 600 "<focus text>"
   ```
   Note the printed job id as JOBID (or read it from `/council:status`).

2. **Read the decision** from the companion — never eyeball the report:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/council-companion.mjs" fixloop-status JOBID --writer claude --needed 2 --json
   ```
   Act on `recommendation`:
   - `stop-approved` -> **stop**: report success, hand the branch back for merge.
   - `stop-escalate-to-human` -> **stop**: not approved but nothing actionable
     (only P2/nits, or an incomplete council). Summarize and ask the user.
   - `fix-and-rereview` -> continue to step 3 with the `actionable` list.
   Also stop-and-escalate if `incomplete: true` (a council with fewer voters than
   needed, e.g. an agent timed out) — do not trust its verdict.

3. **Fix** every actionable finding you agree with, verifying each against the code
   first (findings are hypotheses). For anything you disagree with, record why in the
   round summary instead of blindly changing it.

4. **Commit** the round: `git commit -m "fixloop round <n>: <summary>"`. Leave BASE
   unchanged. Continue to the next round.

## Stop conditions (any one ends the loop)
- `recommendation: stop-approved` (>=2 non-writer approvals on a complete council).
- `recommendation: stop-escalate-to-human` or `incomplete: true` -> summarize, ask.
- Round cap (3) reached without approval -> stop and summarize remaining actionable
  findings for the user. Never loop past the cap.
- A finding needs a human decision (auth/data-loss/compliance with no consensus) ->
  pause and ask via AskUserQuestion.

## Rules
- Bounded: never exceed 3 rounds.
- The writer (you) fixes and never self-approves; approval needs the other agents.
- Every round leaves a clean commit so the loop is auditable and revertible.
