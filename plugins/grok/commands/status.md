---
description: Show running and recent Grok jobs for this repository
argument-hint: "[job-id]"
allowed-tools: Bash(node:*)
---

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" status $ARGUMENTS
```

Present the output to the user.
