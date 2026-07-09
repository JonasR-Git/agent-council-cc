---
description: 3-agent deliberation — independent reviews then peer critique (Claude + Codex + Grok)
argument-hint: "[--wait|--background] [--base <ref>] [--codex-model <id>] [--grok-model <id>] [focus text]"
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), Write, AskUserQuestion
---

# Council Deliberation protocol

All three parties **think independently first**, then **evaluate each other**.

Raw arguments:
`$ARGUMENTS`

## Protocol (follow exactly)

### Phase A — YOU (Claude) independent review FIRST

1. Inspect the review target (working tree or `--base` branch) with git + code tools.
2. Write structured findings **without** calling Codex/Grok and **without** reading their opinions.
3. Save JSON to a temp file in the repo (or OS temp), e.g. `.council-claude-r1.json`:

```json
{
  "agent": "claude",
  "summary": "...",
  "verdict": "approve|approve_with_nits|request_changes|block",
  "findings": [
    {
      "id": "claude-1",
      "severity": "P0|P1|P2|nit",
      "category": "bug|security|concurrency|data-loss|auth|compliance|performance|design|test|dx|other",
      "title": "short",
      "detail": "what/why",
      "file": "path/or/null",
      "line": null,
      "confidence": 0.7
    }
  ]
}
```

### Phase B — Codex + Grok (R1 independent + R2 peer critique)

Run (prefer background for large diffs):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/council-companion.mjs" deliberate --claude-findings .council-claude-r1.json $ARGUMENTS
```

What the companion does:
- **Round 1:** Codex and Grok each produce independent structured findings (parallel).
- **Round 2:** Grok critiques Codex findings; Codex critiques Grok findings; both critique Claude if the file was provided.
- Merges consensus vs unique + peer votes into one report.

### Phase C — YOU peer-evaluate and decide

After the report (or `/council:result`):
1. Vote on Codex/Grok consensus items: agree / disagree / uncertain.
2. Scrutinize unique findings (especially auth, concurrency, data-loss).
3. Produce a **decision table**: Fix now | Verify | Ignore — with `file:line` checks.
4. **Do not implement fixes** unless the user asks.

## Rules

- Review-only during this command.
- Never skip Phase A (Claude must think alone first).
- Prefer `--background` for non-trivial diffs; then `/council:status` + `/council:result`.
- Models: `--codex-model` / `--grok-model` or `.council.yml` / CLI config files.
