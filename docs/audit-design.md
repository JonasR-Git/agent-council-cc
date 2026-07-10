# Design: `/council:audit` — whole-project audit (+ safe auto-fix)

> Status: **design / not yet implemented.** This plan was produced by dogfooding
> `/council:plan` twice (two 3-agent Claude+Codex+Grok planning rounds, jobs
> `council-a0734c9b` and `council-564673cb`). The second round's peer critique
> deliberately dialed back an over-aggressive "find everything and auto-fix
> everything" design into the **safe** model below.

## Goal

A "big review" for the council plugin that reviews the **entire project** (not a
git diff) by area/domain, focused on **SSOT / consolidation** and **architecture**
plus other lenses (security, tests, dead code, docs, correctness, dependency
hygiene). It must find as **many real defects as possible, as precisely as
possible**, scale to **3000+ files**, optionally **fix** what is provably safe with
an agent team, and be able to run **endlessly / incrementally** as a background
babysitter — without ever damaging the repo.

## The one idea that makes it work

**Static analysis is the precision engine; agents are the judgment.** Local issues
(a bug in one module) need the module's real code; global issues (duplication,
layering) can only be seen *across* modules. So the engine is **map-reduce over a
deterministic static fact base**, not agents skimming files.

And the hard-won safety rule from the council:

> **Static regex facts are CANDIDATES, not authority.** Nothing is deleted or
> merged automatically from them. The flow is **detect → propose → verify → fix
> only what is provably safe + tested.** Consolidation (merge dupes / remove dead
> code) is **propose-only** until a verified, deterministic, testable transform
> exists.

## Architecture

### 1. Static fact base — `lib/codebase-model.mjs` (+ `dup-detect`, `import-graph`)
Zero-dep, computed once and cached by content hash. Pins JS/JS-ESM and explicit
import forms; anything it cannot prove is emitted **low-confidence**. Signals:

- **Import/export graph** (regex over ESM `import`/`export`): cycles (Tarjan SCC),
  layering violations (vs a declared layer order), dead/orphan exports, fan-in/out,
  blast radius. *Graph findings ship as agent-verifiable candidates, never as
  authorization to delete* (external consumers, package `exports`, framework
  entrypoints, dynamic imports and aliases are invisible to regex).
- **Near-duplication** — line+token k-gram shingling + winnowing fingerprints →
  duplicate clusters (copy-paste & parallel implementations = SSOT breaks).
  Deterministic; min-clone-size threshold + ignore-globs (generated/vendored);
  ranked by size × occurrences.
- **Complexity** per function: nesting depth, branch/return count, length, params.
- **Git**: churn (commits/N days), co-change coupling (files that co-commit =
  hidden coupling), bus-factor via blame.
- **Smells** (regex): empty/`catch {}`, `console.*`, `TODO/FIXME/HACK/XXX`,
  `@ts-ignore`/`eslint-disable`, magic numbers, God files, duplicated string
  literals, long param lists.
- **Test mapping**: module ↔ test-file existence; untested exports.
- **Config / SSOT sprawl**: same constant/env/config key defined in >1 place.

Output: (a) direct **candidate** findings for the mechanical issues, and (b) a
**hotspot score** per module/function = `norm(complexity × fan_in × churn ×
co_change × smell_density)` used to target and order agent review. Persisted as
`docs/codebase-map.json` (+ a human report) — a living artifact valuable on its own
(architecture / onboarding) and the basis for cheap incremental re-audit.

### 2. Deep local review — `lib/audit-unit.mjs` (NOT the diff path)
The diff-centric `deliberate`/`git-context` path is **not** reused as-is. A new
**unit-context-pack builder** assembles ONE module's full source (deterministically
**split into bounded chunks** for oversized modules, with supplied-vs-total coverage
accounting) + its direct imports' signatures + the static facts targeting it, into a
bounded prompt with audit-specific per-lens prompts. It calls the `agents.mjs`
structured runners directly, at **high effort on high-hotspot** units, with
**multi-angle lenses** (each lens = a distinct failure mode), **loop-until-dry**
(re-spawn finders until K rounds add nothing new), and **verify-first** to refute
false positives.

### 3. Global reduce (SSOT + architecture)
Reasons over the model (import graph + duplicate clusters + layering), not over full
files. Verifies each candidate by reading only the 2-3 flagged units. Hierarchical
for huge repos (cluster by top-dir → synth within → synth across summaries).

### 4. Consolidation — **detect + propose first**, auto-fix only if provably safe
Runs before the deep review so bugs aren't found N times across copies. But
consolidation is **report/propose-only** (written to `docs/AUDIT.md` as a migration
proposal: "source of truth = X, redirect the rest"). It is auto-applied **only** for
findings that have a verified, deterministic, testable transform with green tests —
otherwise it stays a proposal.

### 5. `--fix` agent team — safe write path
- **Write-capable runner** (spawn-claude write-mode / codex task write / grok
  `--write`) with an explicit per-backend **admission matrix** (who may write +
  sandbox), an **input snapshot** (including dirty/untracked audited content), and
  **touched-file enforcement**.
- Only **localized** findings with a proven transform are eligible; **cross-cutting →
  doc**, never auto-patched. Default (no `--fix`) is **report-only**.
- **Integration**, not naive parallel worktrees: a single **integration branch** +
  a **dependency/overlap scheduler** (one writer per file *and* serialize dependent /
  multi-file / shared-caller findings), per-finding commits, **post-integration
  re-review**, and **rollback** of any commit whose re-review fails.

### 6. Durable session, budget, coverage — `lib/audit.mjs`
- **Session** (from v2): `session.json` + atomic per-`(unit,lens)` result files —
  crash-safe, idempotent, full evidence/provenance so reports reconstruct and stale
  results invalidate on content/prompt/model/lens hash change.
- **Finite invocation budget**: ONE counter per run, charged for every agent call
  (local/synth/verify/fix/retry). Not the provider-window `budget_guard`. When the
  budget dies mid-lens-set → clean checkpoint + stop; next run resumes by priority.
- **Honest coverage**: track `mapped` vs `sampled` vs `supplied` LOC/files
  separately — never claim ~100% when agents saw only hot chunks.
- **Incremental hash** = effective working-tree content (tracked+dirty+untracked
  minus gitignore) + shared inputs (manifests, lockfiles, audit policy, lens/prompt
  version, model id). **Generated audit artifacts** (`AUDIT.md`, `codebase-map.json`)
  are **excluded** so the auditor can't trigger itself indefinitely.
- **Backend**: the worker queue forces **spawn Claude or omits Claude** (the session
  backend consumes a prewritten findings file and cannot serve a worker-driven queue).

### 7. `--endless`
Repeated **bounded** runs (static → consolidate-propose → deep → reduce →
fix-if-safe → re-map) over the priority queue, with per-pass checkpoints,
diminishing-returns stop per domain (K dry passes), re-auditing only content-changed
modules, and provider-window back-off. Interruptible without losing work.

### 8. Surface
- Companion subcommands: `audit model | static | consolidate | run | synth | fix |
  report`, plus an explicit `kind: "audit"` **background-worker dispatch** (so
  `--background` / `/council:status --watch` work).
- Slash: `/council:audit [--areas a,b | --all] [--lens ssot,architecture,…] [--fix]
  [--doc] [--endless] [--resume] [--session <id>] [--budget <n>]`.
- Flags/config chosen **parser-compatible** with `parseArgs` / `parseSimpleYaml`
  (e.g. `--resume` boolean + separate `--session <id>`; flat `.council-audit.yml`),
  or those parsers are extended **and tested**.
- Reuses: ledger (cross-run dedupe/recognition), scope classifier (localized vs
  cross-cutting), verify-first, worktree, watch dashboard, findings merge/consensus.

## Phasing (each shippable; grows sharper but stays safe)

- **V1 — read-only health report.** Static fact base → **candidate** findings
  (confidence-tagged) + honest coverage + `docs/codebase-map.json` + report. **Zero
  auto-change.** Immediately useful and mostly deterministic/cheap.
- **V2 — deep review + propose.** Spawn-backend audit runner + split unit-context +
  loop-until-dry + verify + global reduce + durable session + finite budget. Report +
  proposals (incl. consolidation proposals to the doc). Still no auto-fix.
- **V3 — safe `--fix`.** Auto-fix ONLY provably-safe localized findings (verified
  transform + green tests), via the write-capable runner + integration-branch
  scheduler + rollback. Consolidation stays propose-only.
- **V4 — `--endless` + dashboard + hierarchical reduce** for 3000+ files.

## Top risks (and how they are bounded)

- **`--endless` runaway cost** → one finite per-run budget, diminishing-returns
  stop, provider back-off, per-pass checkpoints, exclude generated artifacts.
- **Bad auto-edits** → localized + proven-transform + verify-or-rollback only;
  consolidation propose-only; report-only by default.
- **Unsound regex static facts** → everything low-confidence until agent-verified;
  no deletion/merge from static alone.
- **Fix composition conflicts** → integration branch + dependency scheduler +
  post-integration re-review + rollback.
- **Duplication false positives** → winnowing threshold + ignore-globs + rank +
  agent-verify before proposing.
- **Scale** → consolidation-first shrinks the surface; strict hotspot ranking does
  the top X% first; coverage makes the tail explicit; incremental re-audit keeps
  steady-state cheap.

## Provenance

Ranked plans across the two council rounds: Codex 7/10, Grok 6/10, Claude 5-5.5/10.
The council's critique is the reason this design is safe rather than merely
ambitious — the key correction was "detect → propose → verify → fix only the
provable," not "auto-fix everything."
