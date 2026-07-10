---
description: Show the stored council report for a finished job
argument-hint: "[job-id] [--summary]"
allowed-tools: Bash(node:*)
---

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/council-companion.mjs" result $ARGUMENTS
```

Prefer `--summary` when you only need the decision-relevant parts (merged findings /
ranking / debate outcomes) - it skips the raw R1/R2 bodies and saves tokens. Full
agent output stays available without `--summary` and in the job's artifact files.

`--html` writes a self-contained, styled HTML report (sortable findings table with
severity colours + consensus badges, verdicts, solve ranking, collapsed full report)
to the job's artifacts dir and prints its path — open it in a browser or share it.

Present the report, then add a brief Claude synthesis (consensus vs unique P0 findings). Do not re-run the review.
