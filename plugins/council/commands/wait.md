---
description: Block until a council background job finishes (process-exit semantics for watchers)
argument-hint: "[job-id] [--follow] [--timeout <seconds>] [--interval <seconds>]"
allowed-tools: Bash(node:*)
---

Run in the background so the process exit wakes the session when the job is done:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/council-companion.mjs" wait $ARGUMENTS
```

- Without a job-id it waits for the newest job.
- `--follow` streams each phase change (collecting-context / r1 / r2 / debate ...) to stderr.
- `--interval <seconds>` sets the poll interval (default 5s); `--timeout <seconds>` the max wait (default 3600s).
- Exits 0 when the job finished; exits 1 on `--timeout`.
- Combine with `--json` for machine-readable status.
