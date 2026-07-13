---
description: Whole-project audit — static candidates + deep agent review + safe test-gated auto-fix + endless review loop
argument-hint: "[run|review|fix|endless] [--groups fine|tier|lens] [--loop] [--supervise] [--autonomy <lvl>] [--areas dir1,dir2] [--budget <n>] [--max-units <n>] [--sarif] [--html] [--doc] [--from <json>] [--dry-run] [--max-passes <n>] [--dry-streak <n>] [--json]"
allowed-tools: Bash(node:*)
---

Run the whole-project audit:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/council-companion.mjs" audit $ARGUMENTS
```

- **Static (default)** — no agents, read-only except `--write-map`. Emits candidate
  findings + hotspots + coverage.
- **`run`** — the self-driving audit: inventory → mandatory surface → the review
  engine → canonical findings → a ranked risk register → a pass/fail gate, as one
  schema-valid report. `--sarif [--sarif-path <p>]` also writes a SARIF 2.1.0 log;
  `--base <ref>` scopes to a diff.
- **`review`** — deep agent review of the top `--max-units` hotspot modules by all
  three finders (**Codex + Grok + Claude — six-eyes**), bounded by `--budget <n>`
  agent calls, plus a global SSOT/architecture reduce. `--groups fine|tier|lens`
  opts into the GROUPED path: every (module × lens-group × chunk) cell is reviewed
  by all seats for cell-granular coverage (`--max-cells <n>` bounds the matrix).
  Findings are candidates; you synthesize.
- **`fix`** — **safe auto-fix (v3)**. Fixes ONLY **localized** findings with an
  explicit scope (fail-closed), one writer per file, on an isolated
  `council/audit-fix-<sha>` branch. Each fix must touch only its target file (else
  reverted) and keep the project's tests green (else reverted); every kept fix is
  its own single-file commit. Cross-cutting / SSOT findings and protected paths
  (`.git`, `node_modules`, build output, **`.env`/secrets/`.github` CI/Dockerfile**,
  lockfiles) are **never** auto-patched. A **clean working tree is required** (no
  `--allow-dirty`: the rollback would destroy uncommitted work), a repo-scoped lock
  forbids concurrent runs, and the base branch is untouched — nothing is auto-merged;
  you review the branch. A RED final integration run reports `ok:false`. Findings
  come from `--from <json>` (a prior `review --json`, confined to the project root)
  or a fresh review. `--dry-run` previews the plan without editing; `--min-severity
  <P0|P1|P2>` sets the gate (default P2); `--max-fixes <n>` caps the number of fixes
  (default 50). The test gate is mandatory — `audit fix` only auto-fixes tested code
  and there is no CLI bypass. `--autonomy <lvl>` sets the commit/propose
  dial; `--sensitive-auto-apply` enables §6 council-gated auto-apply of sensitive
  fixes (**only in `--loop`**, gated by unanimous 3-seat patch review); `--html`
  writes a self-contained report; `--retry-on-limit` rides out rate limits.
- **`fix --loop`** — the autonomous **fix-until-dry** loop (M3): review → tier-gate
  (structure → correctness → quality; `--flat` for one flat pass) → fix the localized
  set on ONE isolated branch → re-scope to the blast radius → repeat until dry /
  budget / `--max-passes`. `--resume` continues a checkpointed run. **`--supervise`**
  (M10) wraps it in the endless supervisor so a multi-hour run survives rate-limit
  resets (reset-aware wait + `--resume`). Nothing is auto-merged; you review the branch.
- **`endless`** — **bounded review loop (v4)**. Each pass advances the reviewed
  hotspot window (progressive coverage — pass N reviews the next band, not the same
  top-N), and keeps going until returns diminish (`--dry-streak <n>` consecutive
  passes find nothing new, default 2), the total `--budget <n>` agent calls are
  spent (default 60), or `--max-passes <n>` is hit (default 10) — whichever comes
  first. Findings are deduplicated across passes with a tight key (file + category +
  title). Progress is checkpointed atomically to the state dir; `--resume` continues
  an interrupted run instead of re-spending the budget. This is a **review/propose**
  loop that never edits code (`--supervise` also available); looped AUTO-fix lives in
  the separately-gated **`fix --loop`** above. `--doc` writes the accumulated proposals.
- `--areas a,b` limits the scan to those path prefixes; `--churn-days <n>` sets the
  git-churn window (default 90).
- `--doc` writes findings as **proposals** to `docs/AUDIT.md` (cross-cutting items
  are documented migrations, deliberately NOT auto-patched). The file is
  regenerated in full each run. `--doc-path <file>` overrides the target (must
  stay inside the project root).
- `--write-map` writes `docs/codebase-map.json`; `--json` emits the full model.

Everything reported is a **candidate** (confidence-tagged): the static engine
(import/export graph, line-level duplicate detection, complexity, git churn,
smells, test mapping) cannot prove reachability, so treat findings as leads to
verify — never delete/merge blindly. Duplication is a *consolidation proposal*.

Present the report, then add a short **Claude synthesis**:
1. The top hotspots worth reviewing deeply.
2. Which duplicated blocks are real SSOT breaks worth consolidating (vs incidental).
3. Which dead-export / no-test candidates need verification before acting.

`audit` (static) and `audit review` never auto-edit code — their only writes are the
opt-in artifacts `--write-map` (`docs/codebase-map.json`) and `--doc`
(`docs/AUDIT.md`, or `--doc-path`), confined to the project root. Under `review`,
the Codex/Grok reviewers are prompted read-only but run as external CLIs whose
sandboxing this command cannot itself guarantee. Only `audit fix` writes code, and
only on an isolated branch under the safety rules above. The `endless` subcommand
is a review/propose loop and writes no code. See `docs/audit-design.md` for the
design rationale.
