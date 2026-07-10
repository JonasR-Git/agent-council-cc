---
description: Iterate review -> fix -> re-review until the council approves the diff (bounded rounds)
argument-hint: "[--base <ref>] [--max-rounds 3] [--writer claude] [focus text]"
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Edit, Write, Bash(node:*), Bash(git:*), AskUserQuestion
---

# Council fix loop

Drive a change to council approval: review, fix the actionable findings, re-review
only the fix commits, repeat until >=2 agents approve or a hard round cap is hit.
This productizes the manual loop; you (Claude) are the writer and orchestrator.

Raw arguments: `$ARGUMENTS`

## Preconditions
- Work on a dedicated branch with a clean tree (commit or stash first).
- Record the starting ref: `git rev-parse HEAD` -> call it BASE (or use `--base`).

## Loop (max 3 rounds by default; then hand back to the user)

For round = 1..maxRounds:

1. **Review** the diff since BASE with a full deliberation, writing your own R1 first:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/council-companion.mjs" deliberate --base <BASE> \
     --claude-findings-wait "$TMPDIR/fixloop-claude-r$round.json" --wait-timeout 600 $ARGUMENTS
   ```
   (First round may `--resume` a prior interrupted review of the same snapshot.)

2. **Read the decision** — do NOT eyeball the report; ask the companion:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/council-companion.mjs" fixloop-status --writer claude --needed 2 --json
   ```
   - `approved: true` -> **stop**, report success, hand the branch back for merge.
   - else -> take the `actionable` list (consensus + policy-consensus + P0/P1,
     minus conceded items). The writer's own verdict never counts.

3. **Fix** every actionable finding you agree with. Verify each against the code
   first (findings are hypotheses). For anything you disagree with, note why in the
   round summary instead of blindly changing it.

4. **Commit** the fixes as one commit: `git commit -m "fixloop round <n>: <summary>"`.
   Keep BASE fixed across rounds so each review sees the full cumulative diff, OR
   advance BASE to review only the new commit — default: keep BASE fixed so late
   rounds cannot reintroduce earlier issues.

5. Continue to the next round.

## Stop conditions
- `fixloop-status` reports `approved: true` (>=2 non-writer approvals). Success.
- Round cap reached without approval: **stop and summarize** the remaining
  actionable findings for the user to decide. Do not loop forever.
- A finding needs a human decision (auth/data-loss/compliance policy category with
  no consensus): pause and ask via AskUserQuestion.

## Rules
- Bounded: never exceed `--max-rounds` (hard default 3).
- The writer (you) fixes and does not self-approve; approval needs the other agents.
- Every round leaves a clean commit so the loop is auditable and revertible.
