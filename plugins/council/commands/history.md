---
description: Search past council jobs across time (optionally across all workspaces)
argument-hint: "[--kind review|deliberate|solve] [--since <days>] [--status <s>] [--global] [--json]"
allowed-tools: Bash(node:*)
---

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/council-companion.mjs" history $ARGUMENTS
```

Lists past jobs newest-first with status, kind, date, consensus-finding count, and
summary. Filters: `--kind`, `--since <days>`, `--status`. `--global` scans every
workspace under the state root (e.g. "all deliberations of the last week across all
repos"). Use `--json` for machine-readable output.
