---
description: Whole-project static audit — candidate findings (SSOT/duplication, complexity, dead code, smells) + hotspots, read-only
argument-hint: "[--areas dir1,dir2] [--churn-days <n>] [--write-map] [--json]"
allowed-tools: Bash(node:*)
---

Run the whole-project static audit (v1: deterministic, **read-only**, no agents,
changes nothing):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/council-companion.mjs" audit $ARGUMENTS
```

- `--areas a,b` limits the scan to those path prefixes (default: the whole repo).
- `--churn-days <n>` window for git churn (default 90).
- `--write-map` also writes `docs/codebase-map.json` (the persisted codebase model).
- `--json` emits the full model.

Everything reported is a **candidate** (confidence-tagged): the static engine
(import/export graph, line-level duplicate detection, complexity, git churn,
smells, test mapping) cannot prove reachability, so treat findings as leads to
verify — never delete/merge blindly. Duplication is a *consolidation proposal*.

Present the report, then add a short **Claude synthesis**:
1. The top hotspots worth reviewing deeply.
2. Which duplicated blocks are real SSOT breaks worth consolidating (vs incidental).
3. Which dead-export / no-test candidates need verification before acting.

Do not implement fixes here — this command is read-only. See `docs/audit-design.md`
for the deeper-review and safe `--fix` phases.
