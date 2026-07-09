---
description: Hand a task to Grok Build for investigation or a fix attempt
argument-hint: "[--background] [--write] [--model <id>] [--effort <level>] <prompt>"
allowed-tools: Bash(node:*), Bash(git:*), AskUserQuestion
---

Delegate work to Grok via the local Grok Build CLI.

Raw arguments:
`$ARGUMENTS`

Notes:
- Without `--write`, Grok still may edit depending on CLI permissions; prefer `--write` only when the user explicitly wants patches.
- Long tasks: prefer `--background`.
- For multi-agent review of an existing change, prefer `/council:review` instead.

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" rescue $ARGUMENTS
```

If `--background` is set, do not wait; tell the user to use `/grok:status` and `/grok:result`.
Otherwise return the command output to the user.
