---
description: Whole-project audit — static candidates (SSOT/duplication, complexity, dead code, smells) + optional deep agent review of hotspots
argument-hint: "[review] [--areas dir1,dir2] [--churn-days <n>] [--budget <n>] [--max-units <n>] [--doc] [--write-map] [--json]"
allowed-tools: Bash(node:*)
---

Run the whole-project audit:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/council-companion.mjs" audit $ARGUMENTS
```

- **Static (default)** — no agents, read-only except `--write-map`. Emits candidate
  findings + hotspots + coverage.
- **`review`** — deep agent review (Codex + Grok) of the top `--max-units` hotspot
  modules, bounded by `--budget <n>` agent calls (default 20), plus a global
  SSOT/architecture reduce over the map. Findings are candidates; you synthesize.
- `--areas a,b` limits the scan to those path prefixes; `--churn-days <n>` sets the
  git-churn window (default 90).
- `--doc` writes findings as **proposals** to `docs/AUDIT.md` (cross-cutting items
  are documented migrations, deliberately NOT auto-patched).
- `--write-map` writes `docs/codebase-map.json`; `--json` emits the full model.

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
