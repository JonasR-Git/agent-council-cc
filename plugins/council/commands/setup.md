---
description: Check whether Codex + Grok backends are ready for council reviews
argument-hint: ""
allowed-tools: Bash(node:*), Bash(grok:*), Bash(codex:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/council-companion.mjs" setup --json $ARGUMENTS
```

Present the setup report. Call out any missing backend and the suggested next step.
