---
description: Aggregate per-agent durations and per-kind wall-clock from persisted council job history
argument-hint: "[--days <n>] [--json]"
allowed-tools: Bash(node:*)
---

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/council-companion.mjs" metrics $ARGUMENTS
```

Reads the persisted metrics history (one line per finished job under the workspace
state dir) and reports, over the last `--days` (default 30):
- per kind (review/deliberate/solve): job count + average wall-clock
- per agent: calls, failures, timeouts, average and median call duration

Use this to tune effort tiers and turn limits with real numbers instead of guesses
(e.g. "codex R1 averages 6 min, grok R2 90s"). Unlike `usage`, which reflects the
live job files, `metrics` is an append-only historical record that survives job pruning.
