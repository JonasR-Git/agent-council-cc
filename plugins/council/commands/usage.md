---
description: Aggregate council job statistics (per kind and per agent) plus provider usage pointers
argument-hint: "[--json]"
allowed-tools: Bash(node:*)
---

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/council-companion.mjs" usage $ARGUMENTS
```

Shows for this workspace: jobs per kind (review/deliberate/solve) with wall-clock and
status counts, and per-agent call/failure/timeout statistics across all council rounds.

Token usage is NOT exposed by the external CLIs. For provider quotas point the user to:
- Claude: `/usage` (plan limits) or `/cost` in Claude Code
- Codex: `/status` inside the Codex TUI, or the ChatGPT dashboard
- Grok: the xAI console (grok.com)
