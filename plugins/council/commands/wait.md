---
description: Block until a council background job finishes (process-exit semantics for watchers)
argument-hint: "[job-id] [--timeout <seconds>] [--interval <seconds>]"
allowed-tools: Bash(node:*)
---

Run in the background so the process exit wakes the session when the job is done:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/council-companion.mjs" wait $ARGUMENTS
```

- Without a job-id it waits for the newest job.
- Exits 0 when the job left running/queued; exits 1 on `--timeout` (default 3600s).
- Combine with `--json` for machine-readable status.
