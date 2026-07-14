# CLI surface redesign — FROZEN DESIGN (council-cabd31b4)

> Converged by a 3-model council (Claude + Codex + Grok). This is the AUTHORITATIVE spec for the redesign —
> freeze it BEFORE implementing so all builders produce ONE surface. Backward-compat via a thin ALIAS layer:
> zero flag/command deletions in v1 (aliases only; deprecations warn on stderr, removed only after a major
> version + changelog). The INVIOLABLE rule: **read-only verbs never modify tracked project source or git;
> writing verbs (fix, build) are always test-gated on an isolated branch, never auto-merged.**

## The 7 user-facing verbs
| Verb | mutationClass | Folds | Notes |
|------|---------------|-------|-------|
| `review` | none (RO) / state-only for artifacts | deliberate, adversarial, audit review, audit run, audit endless | `--mode quick\|deliberate\|adversarial\|deep\|endless\|run`. NEVER `--loop`, NEVER any write flag. |
| `fix` | working-tree (test-gated, isolated branch) | audit fix | Run-behavior from `fix:` config. The ONE findings→fixes writer. |
| `plan` | none (RO) | — (stays its own verb) | design → validated PlanSpec. |
| `build` | working-tree (test-gated, isolated branch) | — (stays its own verb) | builds a PlanSpec. 2-step with plan (review the plan, then build). |
| `solve` | none (RO synthesis) | — (stays its own verb) | independent solutions → scored critique → ranking. NOT a review mode (it generates, doesn't critique existing code). The IMPLEMENTATION step is an explicit `fix`/`build`, never `solve` itself. |
| `status` | none (RO) + state-only (cancel, ledger --resolve mutate JOB/LEDGER state, never code) | result, watch, wait, cancel, fixloop-status, overview, history, metrics, usage, ledger | action enum (mutually exclusive). |
| `setup` | state-only (--init writes config; --check/--usage read) | doctor, usage(read) | tool config + diagnose. |

Hidden / internal (NOT in the 7-verb head-count, kept callable): `worker` (spawn protocol — MUST NOT be
renamed; live background jobs depend on it), `worktree` (rare power-user), `benchmark` (power-user). All
hidden from top-level `--help`, still work by their old names.

### The two "endless" loops (a deliberate, safety-driven split — do not confuse)
- **`fix`** = endless review WITH fixes: review → fix → re-review → repeat until dry, test-gated on an
  isolated branch. Loops by default (from `fix:` config); `fix --no-loop` = single pass. This is the old
  `audit fix --loop`. It WRITES.
- **`review --mode endless`** = endless review WITHOUT fixes: keep finding + proposing, never edits. This is
  the old `audit endless` (propose-only). It NEVER writes.
The redesign SPLITS these by verb precisely so the writing loop can never be reached by a read-only intent —
the old surface used the same `--loop` token for both, which is the safety hole this fixes.

### Why these (council corrections to the first proposal)
- **solve stays separate** (P0, unanimous): folding it into `review --mode solve` pollutes the RO mental
  model — solve's workflow continues into implementation via `solve_writer`.
- **NO `--loop` on review** (P0): `--loop` is the WRITE token today (`audit fix --loop`). Reusing it for a
  read-only endless review puts a user one flag from mutating a tree they thought was read-only. `endless`
  → `review --mode endless` (propose-only), NEVER `--loop`. The existing slash `review --loop` (which
  writes) is tech debt this redesign REMOVES (see Appendix E).
- **`setup`, not `config`** (muscle memory); `usage`/`ledger` live under `status` (observation), not setup.

## Architecture (two foundations)
1. **ONE flag registry table** `{ flag, aliasOf, verb, configKey|null, scope, type, default, mutationClass }`
   is the single source that drives: the parser, the config merge, `--no-<key>` generation, `--help`, and
   `setup --check` validation. Kills the flag/config/doc drift the project has today.
2. **`mutationClass` enforcement**: after ALIAS EXPANSION, every resolved invocation carries a mutationClass
   ∈ {none, state-only, working-tree}. Only `fix`/`build` (working-tree) may reach `runAuditFix`/`runBuild`.
   A CI test asserts review/plan/solve/endless/run paths NEVER call a code writer + snapshots the worktree
   before/after and proves no tracked file changed.

## The effective-policy banner (silent-behavior-change defense)
Every `fix`/`build` run prints ONE line at start annotating each resolved knob with its SOURCE:
`loop=true(config) deep=true(config) sensitive_auto_apply=true(local,acknowledged) usage_ceiling=90/90/90(config) max_passes=100(config)`
`setup --check` prints the same resolved policy. `--explain`/`--json` exposes it as metadata. This makes the
precedence chain (flag > verb-config > shared-defaults > built-in) inspectable at all times.

═══════════════════════════════════════════════════════════════════════════════════════════
## Appendix A — essential-flag matrix per verb
═══════════════════════════════════════════════════════════════════════════════════════════
Rule: ESSENTIAL = changes naturally between two runs (inputs, run identity, one-run overrides). CONFIG =
repo policy (flag stays as an override). REMOVABLE = duplicates another knob (kept as an alias).

- **review** (RO): ESSENTIAL `--mode`, `--scope`, `--base`, `--background`, `--json`, `--claude-findings[-wait]`,
  `--skip-<seat>`, focus text; artifact writes `--doc`/`--write-map`/`--sarif` (state-only, documented as
  reports, NOT code). CONFIG (`review:`): default mode/scope, groups/max_cells for deep/endless, areas,
  churn_days, models/effort (top-level). REMOVABLE: `--adversarial`/`--deliberate`→`--mode`,
  `--completeness-critic`→`--mode deep`, `--max-units`→`--max-cells`, per-model flags→`--model <seat>=<id>`.
- **fix** (W): ESSENTIAL `--from`, `--dry-run`, `--resume`, `--json`, `--background`, `--no-<consent>`,
  one-run `--usage-ceiling`/`--pause-at-5h`/`--max-passes`/`--max-fixes`/`--min-severity`. CONFIG (`fix:`):
  loop, deep, epoch_sweep, per_tier, supervise, autonomy, retry_on_limit, usage_ceiling, pause_at_5h,
  max_passes, dry_streak, budget, groups, max_cells + auto-generated `--<key>`/`--no-<key>` overrides for
  EVERY fix: key. REMOVABLE: `--flat`→`--no-per-tier`, `--completeness-critic`→deep.
- **plan** (RO): ESSENTIAL request text/`--problem-file`, `--synthesizer` (override of `plan.synthesizer`),
  `--json`, `--background`. CONFIG (`plan:`): synthesizer, seats.
- **build** (W): ESSENTIAL `--from` (required), `--dry-run`, `--json`, `--base`. CONFIG (`build:`): budgets/
  timeouts ONLY — never an auto-merge or skip-gate key (must not exist).
- **solve** (RO): ESSENTIAL problem text/`--problem-file`, `--claude-plan[-wait]`, `--background`, `--json`,
  `--debate-rounds`/`--debate-resume` (or CONFIG). CONFIG: solve_writer, models.
- **status** (RO/state): ESSENTIAL action enum `--watch|--wait|--result|--cancel|--history|--metrics|--usage|--ledger|--fixloop|--overview`
  (reject two actions), `[job-id]`, `--json`, selectors `--once/--interval/--timeout/--follow/--days/--since/--kind/--all/--global`,
  `--summary`/`--format html`. `--ledger --resolve <fp> …` = state mutation, documented. CONFIG: none.
- **setup**: ESSENTIAL `--init`/`--force`, `--check`, `--no-ping`, `--json`. CONFIG: none (`--init` writes it).

Cross-cutting NEVER-config (Appendix C): `--json`, `--dry-run`, `--from`, `--base`, `--resume`, job-id,
`--background`. Turning a consent ON is never config-only (dual-channel, Appendix D); `--no-<consent>` OFF is
always essential and always wins.

═══════════════════════════════════════════════════════════════════════════════════════════
## Appendix B — complete old→new ALIAS table (nothing breaks; table-driven tests for every row)
═══════════════════════════════════════════════════════════════════════════════════════════
| Old argv | New argv |
|----------|----------|
| `review` | `review` (default mode unchanged — do NOT silent-flip the CLI default) |
| `deliberate` / `deliberation` | `review --mode deliberate` (done) |
| `adversarial` / `adversarial-review` | `review --mode adversarial` (done) |
| `solve` | `solve` (canonical; NOT review --mode) |
| `plan` | `plan` |
| `build` | `build` |
| `audit run` | `review --mode run` (risk-register + gate engine; keep --sarif/--doc export) |
| `audit review` | `review --mode deep` (grouped hotspot review; keep --write-map/--doc) |
| `audit endless` | `review --mode endless` (propose-only loop; NEVER --loop, NEVER fix) |
| `audit fix` / `audit fix --loop` | `fix` (loop etc. from `fix:` config; `--loop`/`--no-loop` override) |
| `status` | `status` |
| `result` | `status --result` |
| `watch` | `status --watch` |
| `wait` | `status --wait` |
| `cancel` | `status --cancel <id>` (job-state mutation, documented) |
| `fixloop-status` | `status --fixloop` |
| `overview` | `status --overview` |
| `history` | `status --history` |
| `metrics` | `status --metrics` |
| `usage` | `status --usage` |
| `ledger` | `status --ledger` (`--resolve` stays here, documented as ledger-state mutation) |
| `setup` | `setup` |
| `doctor` | `setup --check` |
| `benchmark` | `benchmark` (hidden alias; not in top --help) |
| `worktree` | `worktree` (internal; hidden) |
| `worker` | `worker` (internal; hidden; NEVER renamed — spawn protocol) |
Flag aliases: `--flat`→`--no-per-tier`, `--max-units`→`--max-cells`, `--completeness-critic`→`--mode deep`
implication, `--html`→`--format html`, `--follow`→`--watch`, `--codex-model`/etc.→`--model codex=<id>`.

═══════════════════════════════════════════════════════════════════════════════════════════
## Appendix C — the NEVER-config list (safety)
═══════════════════════════════════════════════════════════════════════════════════════════
- The read-vs-write VERB choice (structural, not a flag/config).
- `--dry-run` (may default false, but can NEVER be disabled by config), `--from`/`--base` inputs, resume
  tokens, job ids, `--background`.
- Branch isolation, test-gating, `--no-<consent>` (always honored).
- AUTO-MERGE — must not exist as a capability at all.
- API keys (already env-only).
- CONSENTS outside the dedicated trust channel (Appendix D). No `--deep`/`autonomy`/`loop` may imply a
  consent (preserve companion.mjs:2344-2346 forever).
- A shared `defaults:` block may carry ONLY {budget, groups, max_cells} — never loop/autonomy/consents/
  supervise (a review-intended default must never silently change fix runs).

═══════════════════════════════════════════════════════════════════════════════════════════
## Appendix D — consent containment (the security fix; bundled into this redesign)
═══════════════════════════════════════════════════════════════════════════════════════════
PROBLEM (P1, confirmed live): this repo's tracked `.council.yml` currently commits
`fix.structure_auto_apply: true` + `sensitive_auto_apply: true` → any clone/fork/PR-checkout that carries
those lines auto-applies WRITE fixes with no consent from THAT operator. A dual-key in the SAME committed file
does NOT help (it copies along). REQUIRED design:
1. **Consents are read ONLY from an OUT-OF-TREE channel** — a gitignored `.council.local.yml` in the repo, OR
   env `COUNCIL_TRUST_FIX=1` — NEVER from the tracked `.council.yml`, NEVER from a home/global/included config,
   NEVER from a shared `defaults:` block. Remove the two consent keys from the committed `.council.yml`;
   `fix:` keeps only non-consent run-behavior.
2. **repo_fingerprint binding**: the local trust record stores a fingerprint (hash of `git remote get-url
   origin` + workspace path); a consent applies only when the fingerprint matches → a copied trust file into
   a different repo is ignored with a loud warning.
3. **per-clone acknowledgment**: the FIRST config-sourced-consent run in a given clone requires a one-time
   `--acknowledge-consents`, recorded in the plugin STATE dir (never the repo) → a fresh clone can never
   silently auto-apply.
4. `setup --init` scaffolds consents COMMENTED-OFF (done); `setup --check` warns if a consent is true without
   a valid local trust record or if the policy file is world-writable.
5. `--dry-run` and `--no-<consent>` ALWAYS win; the effective-policy banner prints the consent source +
   `(acknowledged)` and prints to stderr EVEN under `--json`.
Blast radius stays bounded by the test-gate + isolated branch, but (3) closes the PR-checkout vector.

═══════════════════════════════════════════════════════════════════════════════════════════
## Appendix E — slash/skill surface (part of the contract, not an afterthought)
═══════════════════════════════════════════════════════════════════════════════════════════
Align the 8 slash commands to the 7 verbs: `/council:review` (RO modes only — REMOVE the write `--loop`
documented in commands/review.md:19-34; that write-sugar violated the hard rule), `/council:fix` (new/explicit
write verb), `/council:plan`, `/council:build`, `/council:solve`, `/council:status`, `/council:setup`
(absorbs doctor). A human fix-loop is an explicit skill that shells `fix` then `review` as SEPARATE verbs —
never a review flag.

═══════════════════════════════════════════════════════════════════════════════════════════
## Config schema (target) + the parser blocker
═══════════════════════════════════════════════════════════════════════════════════════════
BLOCKER (codex): the current `parseSimpleYaml` is FLAT + `parseFixBlock` is a one-off; `review:`/`plan:`/
`build:`/`status:` blocks would be silently DISCARDED. STAGE 1 must ship a generalized bounded-nesting YAML
reader (zero-dep) OR per-block extractors, with a LOUD unknown-key warning (a typo like `epoch_sweeps:` must
warn, never silently no-op) surfaced at load AND in `setup --check`. `config_version: 1`. Precedence: explicit
flag (incl. `--no-`) > verb block > whitelisted `defaults:` > built-in. INVARIANT (regression-tested PER
VERB): a missing verb block ⇒ behavior byte-identical to today.
```yaml
config_version: 1
# shared seats/policy (top-level, already supported) — models/reviewers/focus/consensus/openrouter …
defaults:            # HARD whitelist: budget, groups, max_cells ONLY
review:  { default_mode: deliberate, scope: auto, groups: lens }
fix:     { loop: true, deep: true, epoch_sweep: true, per_tier: true, supervise: true,
           autonomy: aggressive, retry_on_limit: true, usage_ceiling: "90/90/90",
           pause_at_5h: "auto:90", max_passes: 100, budget: 2000 }   # NO consents here
plan:    { synthesizer: claude }
build:   { }        # budgets only; no skip-gate/auto-merge keys allowed
status:  { interval: 2 }
# consents live ONLY in gitignored .council.local.yml / COUNCIL_TRUST_FIX (Appendix D)
```

═══════════════════════════════════════════════════════════════════════════════════════════
## Staged build plan (each stage council-hardened; zero deletions, aliases + tests per stage)
═══════════════════════════════════════════════════════════════════════════════════════════
1. **Nesting YAML parser + unknown-key warnings** (unblocks per-verb config). Byte-identical-without-block
   per verb. Tests.
2. **Flag registry table** driving parser/merge/`--no-`/help/check. Tests.
3. **Verb dispatch + alias layer** (Appendix B) + `mutationClass` enforcement + the RO-never-writes CI test.
   Table-driven test for EVERY alias row + every historical flag (canonical AST + effective value + source).
4. **Consent containment** (Appendix D): move consents out of the tracked file → local/env + fingerprint +
   per-clone acknowledgment + banner. Trust tests (copy/clone/move/change-remote → consent invalid).
5. **Slash/skill layer** (Appendix E): align 8 commands to 7 verbs; remove `review --loop` write-sugar.
6. **Acceptance gates**: worktree-snapshot no-write proof for review/plan/solve; fix/build mutation-class +
   isolated-branch + never-auto-merge invariants; `--explain` effective-policy metadata; JSON stdout purity.
