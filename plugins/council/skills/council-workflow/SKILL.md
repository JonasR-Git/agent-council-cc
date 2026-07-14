---
name: council-workflow
description: >
  Multi-model code review: Claude + Codex + Grok. /council:review runs the 3-way
  deliberate protocol by default (independent then mutual critique); add --quick for a
  cheaper dual review or --adversarial to challenge — review is READ-ONLY and never
  writes. To fix findings autonomously use /council:fix (the one write verb).
  /council:plan designs an approach; /council:solve implements it.
---

# Council workflow

## Choose a mode

| Mode | Command | When |
|------|---------|------|
| **Deliberate (best)** | `/council:review` | Before merge, risky changes, user wants mutual evaluation |
| Dual review | `/council:review --quick` | Faster second opinions (no peer round) |
| Adversarial | `/council:review --adversarial` | Challenge design/direction |
| **Fix (write)** | `/council:fix` | Autonomous review -> fix -> re-review loop on an isolated, test-gated branch — the ONE write verb (never a review flag) |
| **Plan** | `/council:plan` | Design an approach: independent plans -> scored critique -> ranked synthesis (no code) |
| **Solve** | `/council:solve` | Plan + one writer implements + council review |

## Deliberate protocol (3 agents)

```text
Round 1 independent:  Claude, Codex, Grok (no peeking)
Round 2 peer:         Grok critiques Codex, Codex critiques Grok
                      (+ both critique Claude if file provided)
Then:                 Claude final decision table (Fix/Verify/Ignore)
```

Claude **must** write its R1 JSON outside the repo, preferably to an OS temp path. Repo-local scratch files contaminate review input because untracked file bodies are now included.

Run after Claude R1 is written:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/council-companion.mjs" review --mode deliberate --claude-findings "$TMPDIR/council-claude-r1.json"
```

Or start Codex/Grok first and wait for the file:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/council-companion.mjs" review --mode deliberate --claude-findings-wait "$TMPDIR/council-claude-r1.json" --wait-timeout 600
```

## Solve protocol (plans instead of findings)

```text
Phase 0: Claude condenses the problem to an OS-temp file
Phase 1: companion starts Codex+Grok plans; Claude plans in parallel (--claude-plan-wait)
Phase 2: cross-critique with scores (1-10) + blockers -> ranking [+ bounded debate]
Phase 3: Claude synthesizes final plan -> user approval
Phase 4: ONE writer implements on a branch (policy solve_writer)
Phase 5: /council:review on the diff; writer's verdict does not count
```

## Policy

Repo file `.council.yml` (scaffold with `/council:setup --init`): models, focus, consensus categories, skip paths, `agent_timeout_minutes`, `peer_critique_severities`, `r2_effort`, `debate_rounds`, `solve_writer`, `reviewers`, `claude_backend`.

## Models

- Codex: `~/.codex/config.toml` or `--codex-model`
- Grok: `~/.grok/config.toml` or `--grok-model`
- Claude: Claude Code session model (separate)

## Rules

- **`/council:review` never writes** — it stops at a decision table. A human fix-loop
  shells `/council:fix` (write) then `/council:review` (read-only) as SEPARATE verbs;
  fixing is never a review flag.
- One writer per branch; reviewers read-only.
- Findings = hypotheses until verified (`file:line`).
- Prefer consensus P0s; unique findings need extra scrutiny.
- Do not run dual write-rescues without worktrees.
