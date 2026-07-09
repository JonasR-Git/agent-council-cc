---
description: Show the stored council report for a finished job
argument-hint: "[job-id]"
allowed-tools: Bash(node:*)
---

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/council-companion.mjs" result $ARGUMENTS
```

Present the report, then add a brief Claude synthesis (consensus vs unique P0 findings). Do not re-run the review.
