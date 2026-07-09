---
description: Run a Grok code review against local git state (read-only)
argument-hint: "[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch] [--model <id>]"
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

Run a Grok review through the Grok Build CLI (read-only).

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- Review-only. Do not fix issues or apply patches.
- Return Grok's output to the user.

Execution mode rules:
- If arguments include `--wait`, run in the foreground.
- If arguments include `--background`, run as a Claude background Bash task.
- Otherwise, estimate size via `git status --short` / `git diff --shortstat` and recommend background unless the change is tiny (1–2 files). Use `AskUserQuestion` once with:
  - `Run in background (Recommended)` when not tiny
  - `Wait for results` when tiny / or when user likely wants it

Foreground:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" review $ARGUMENTS
```

Background (do not wait for completion):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" review --background $ARGUMENTS
```

After background launch: tell the user to check `/grok:status` and `/grok:result`.
