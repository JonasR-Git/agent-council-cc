---
name: council-workflow
description: >
  Multi-model code review: Claude + Codex + Grok. Prefer /council:deliberate when the
  user wants agents to think independently then evaluate each other. Use /council:review
  for a cheaper dual review without peer round.
---

# Council workflow

## Choose a mode

| Mode | Command | When |
|------|---------|------|
| **Deliberate (best)** | `/council:deliberate` | Before merge, risky changes, user wants mutual evaluation |
| Dual review | `/council:review` | Faster second opinions (no peer round) |
| Adversarial | `/council:adversarial` | Challenge design/direction |
| Single | `/codex:review` or `/grok:review` | One vendor only |

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
node "${CLAUDE_PLUGIN_ROOT}/scripts/council-companion.mjs" deliberate --claude-findings "$TMPDIR/council-claude-r1.json"
```

Or start Codex/Grok first and wait for the file:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/council-companion.mjs" deliberate --claude-findings-wait "$TMPDIR/council-claude-r1.json" --wait-timeout 600
```

## Policy

Repo file `.council.yml` (see marketplace `.council.example.yml`): models, focus, consensus categories, skip paths, and `agent_timeout_minutes`.

## Models

- Codex: `~/.codex/config.toml` or `--codex-model`
- Grok: `~/.grok/config.toml` or `--grok-model`
- Claude: Claude Code session model (separate)

## Rules

- One writer per branch; reviewers read-only.
- Findings = hypotheses until verified (`file:line`).
- Prefer consensus P0s; unique findings need extra scrutiny.
- Do not run dual write-rescues without worktrees.
