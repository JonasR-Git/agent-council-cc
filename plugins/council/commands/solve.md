---
description: 3-agent problem solving - independent plans, cross-critique with scores, synthesis, single-writer implementation, council review
argument-hint: "[--wait|--background] [--codex-model <id>] [--grok-model <id>] [--debate-rounds 0|1|2] [--debate-resume] [problem text]"
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), Write, Edit, AskUserQuestion
---

# Council Solve protocol

Three agents (Claude + Codex + Grok) solve a problem together: independent plans first,
then mutual critique with scores, then ONE synthesized plan, ONE writer, and a council
review of the result. No free-running chat — structured, bounded rounds only.

To only design the approach without implementing it, use `/council:plan` (Phases 0-3,
then stop).

Raw arguments:
`$ARGUMENTS`

## Protocol (follow exactly)

### Phase 0 - YOU (Claude): condense the problem

1. Clarify the problem statement from the user's text + repo context (read key files).
2. Write it to an OS temp file **outside the repo** (e.g. `$TMPDIR/council-problem.md`).
   Include: goal, constraints, relevant files/subsystems, acceptance criteria.

### Phase 1 - start the companion FIRST, then write your own plan (parallel)

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/council-companion.mjs" solve --problem-file "$TMPDIR/council-problem.md" --claude-plan-wait "$TMPDIR/council-claude-plan.json" --wait-timeout 600 --background
```

While Codex + Grok plan (R1), write YOUR independent plan to `$TMPDIR/council-claude-plan.json`
(schema: `schemas/plan.schema.json` — agent/summary/approach/steps/risks/tradeoffs/effort/confidence).
Do NOT read their plans first. The companion picks your file up automatically.

### Phase 2 - companion: cross-critique + ranking (automatic)

- Each agent scores the other plans (feasibility/risk/simplicity/completeness 1-5, overall 1-10),
  lists blockers and improvements. Optional bounded debate on blockers via `--debate-rounds 1|2`.
- Report: ranked plans + score matrix + blockers/improvements (+ debate outcomes).

### Phase 3 - YOU: synthesize and get approval

1. Take the best-ranked plan as the skeleton; graft the strongest improvements from the others.
2. Resolve or explicitly accept every blocker.
3. Present the final plan to the user (AskUserQuestion) and get approval BEFORE implementing.

### Phase 4 - implementation: exactly ONE writer

- Writer per `.council.yml` `solve_writer: claude|codex|grok` (default claude) or user choice.
- **Isolate the writer in a git worktree** so the main tree stays usable and the
  one-writer rule is enforced by construction:
  ```bash
  node "${CLAUDE_PLUGIN_ROOT}/scripts/council-companion.mjs" worktree add <slug>
  # -> creates branch council-solve/<slug> + a sibling worktree dir; work there
  # ... implement + commit inside the worktree ...
  node "${CLAUDE_PLUGIN_ROOT}/scripts/council-companion.mjs" worktree remove <slug>
  ```
- codex -> codex plugin task (write mode) with `--cwd <worktree>`; grok -> `/grok:rescue --write`; claude -> implement in the worktree.

### Phase 5 - council review of the result

- Run `/council:review` on the branch diff (`--base <default-branch>`).
- Approval rule: at least 2 agents `approve`/`approve_with_nits`; the writer's own verdict does not count.
- Fix loop until approved; then hand back to the user for merge.

## Rules

- Phases 0-3 are read-only for everyone.
- Never let an agent see the other plans before its own is written (independence).
- Prefer `--background` + `/council:status` (add `--result` for the report) for anything non-trivial.
- Debate is opt-in and bounded (max 2 rounds, max 6 items) — never a free chat.
