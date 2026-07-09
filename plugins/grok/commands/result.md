---
description: Show stored output for a finished Grok job
argument-hint: "[job-id]"
allowed-tools: Bash(node:*)
---

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" result $ARGUMENTS
```

Present the stored result. Do not re-run the job.
