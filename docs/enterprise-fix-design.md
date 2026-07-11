# Enterprise-Fix — autonomous, tiered, measured-safe code improvement

`/council:audit fix` (a.k.a. enterprise-fix) autonomously makes an entire codebase
better on **one isolated git branch** (never auto-merged), looping until no
meaningful findings remain, and **deciding for itself** what to fix — with safety
that is *measured, not asserted*.

This document is the hardened design. It supersedes the informal sketch and folds
in a 6-agent council review (2× Fable 5, 2× Codex 5.6-max, 2× Grok — see
§11 for provenance and scores). It builds on the existing audit stack
(`docs/audit-design.md`, `docs/audit-schema.md`) rather than replacing it.

---

## 1. Goal & principles

- **Autonomous & self-deciding.** The run never blocks on a human mid-flight. It
  decides what to fix, what to only propose, and when it is done.
- **The branch is the safety net.** Because nothing is auto-merged, the system may
  act aggressively on its branch; the human's single decision is to merge or discard
  ONE branch at the end. Autonomy and safety are therefore *not* in tension.
- **Measured, not asserted.** "Won't break the repo" must be a measurement (coverage
  of the changed line, an honest characterization test, a sound compiler/lint
  oracle) — not the claim "tests are green". This is the single most important
  correction the council made.
- **Prune before you polish.** The biggest token optimization is Tier 0: don't
  lovingly refactor code that should be removed or redesigned.
- **Static-first, agents-last.** Everything a graph/AST/lint can decide costs zero
  agent tokens. Agents are spent only on judgment, semantic bugs, and verification.
- **Reuse the crown jewel.** `lib/audit-fix.mjs` (branch isolation, single-writer
  `enforceTouched`, test gate, revert-on-red, repo lock, per-fix commit, no
  auto-merge) is production-grade. Everything here *extends* its gate stack; nothing
  forks it.

---

## 2. The intake (4 startup questions)

`audit fix` opens with a short interactive intake (asked by the command/skill layer
via the host's question UI, then passed to the companion as flags). Four questions,
each with a sensible default so hitting enter four times is a valid full run.

| # | Question | Options (default first) | Flag |
|---|----------|-------------------------|------|
| 1 | **Autonomy level** | `aggressive` (default) · `conservative` · `propose-only` · `per-run` | `--autonomy` |
| 2 | **Scope** | `whole project` (default) · `paths <globs>` · `changed since <base>` | `--scope` / `--base` / `--areas` |
| 3 | **Depth & stop** | `until dry` (budget-capped, default) · `single pass` · `budget <N>` | `--stop` / `--budget` / `--max-passes` |
| 4 | **Exclusions & focus** | `none` (default) · `never-touch <globs>` · `only tiers/lenses <list>` | `--never-touch` / `--tiers` / `--lenses` |

**Autonomy levels** map onto the commit-vs-propose boundary (never onto "ask the
human mid-run"):

- `aggressive` **(default)** — commit everything that passes the *measured* gates
  (§4/§5). Only the machine-unprovable classes (§6) stay proposals — not because we
  ask permission, but because they cannot be proven safe automatically.
- `conservative` — commit only high-confidence, behavior-preserving fixes; everything
  else is a proposal (smaller diffs to review).
- `propose-only` — never commit; produce the full proposal set (a pure audit++).
- `per-run` — no fixed default; the level is stated per invocation.

Auto-detected values (test command, lint/type-check command, base branch) are shown
for confirmation, not asked cold. A run is fully reproducible from its recorded
intake.

Optional 5th prompt (post-run, not blocking): `leave branch` (default) vs
`open a PR grouped by fix-cluster`.

---

## 3. The tier pipeline

```
Static fact-base (0 agent tokens: import graph, dup index, complexity, churn, bug-mining)
   │
TIER 0  "Does this make sense?"           (propose-only; prunes the rest)
   │
TIER 1  Structure / SSOT                  (behavior-PRESERVING)
   │
TIER 2  Correctness (bugs/concurrency/security/data)   (behavior-CORRECTING)
   │
TIER 3  Quality (tests / performance / docs)
   │
End: full suite · gap report · ONE branch → human merges
```

Each tier loops-until-dry: it repeats passes until `K` consecutive passes find
nothing new above the risk-floor, OR the budget is spent, OR `--max-passes` is hit.
Between passes the fact-base is **re-mapped** (see §7 for the cache correctness rules
— naive per-file content hashing is unsound here).

### Tier 0 — logical-sense (the user's "what logically makes sense" layer)

Tier 0 judges the *design decision*, not the implementation. Its verdicts change the
*target* of the mechanical tiers, not code text; its evidence lives outside the code
text (reachability, usage, history, spec). It is **predicate-driven**: every finding
type has a machine-measurable trigger over the fact-base — **no firing predicate, no
finding** (this is what stops it degenerating into "feels over-engineered").

Taxonomy (each with its signal):

1. **Dead feature / unreachable capability** — no entry-point path reaches it.
2. **Speculative generality** — abstraction with exactly one instantiation; a param
   that is the same value at 100% of call sites; a config option never set off-default
   anywhere (repo + docs + CI).
3. **Wrong abstraction / leaky boundary** — files across a boundary co-change > X%.
4. **Redundant concept** — two abstractions with heavily overlapping call-site sets
   (text-dedup misses this because implementations differ).
5. **Misplaced responsibility** — a function's fan-in is dominated by one foreign
   module and its data deps point there.
6. **Missing concept (shotgun surgery)** — the same param tuple travels N signatures;
   the same type switch repeats at M sites.
7. **Zombie flag / stale branch** — a flag literal is set to one value repo-wide.
8. **Spec/intent mismatch** — README/doc/docstring/name promises X, code does Y.
9. **Complexity without payoff** — a hotspot whose output a simpler existing path
   also produces.
10. **Over-layered indirection** — pass-through chains ≥ 2 with no added logic.

**Verdict map** (persisted in the session state + ledger): `keep` (default) ·
`remove?` · `merge-into(X)?` · `redesign?` · `relocate?` · `quarantine` (contested).

**Gating of the mechanical tiers** (the token win):

- `remove?` → mechanical tiers **skip** the unit entirely (no char-test, no bug-fix,
  no dedup *into* it). **Exception (P0-security override):** an active
  security/data-integrity P0 in *reachable* code is still verified — a live hole does
  not wait for a delete decision.
- `merge-into(X)?` → X is the designated SSOT survivor; consolidation and correctness
  fixes are redirected to X (fixing the same bug in doomed copies is waste).
- `redesign?` → suppress the Quality tier (polishing code whose shape will change is
  burned tokens); Correctness still runs in propose mode.
- `keep` → full pipeline.

Gating on *unconfirmed* verdicts is safe because the failure mode is asymmetric: a
wrong `remove?` means "not polished this pass" (deferred, nothing destroyed); a
rejected proposal returns the unit to the queue next pass. Rejected proposals persist
in the ledger — the human teaches the system intentionality exactly once.

**Adversarial intent-defense** (what keeps Tier 0 honest): before any finding becomes
a proposal, a second agent is tasked to *defend* the code — searching the introducing
commit, PR text, README/BACKLOG, comments, test names for documented intent. Found
intent → the finding is demoted to `quarantine` or annotated with the cited intent.
Intent sources are first-class input: `@audit-keep <reason>` annotations and
`intentional:` globs in `.council.yml` force `keep`. **Age guard:** young code
(< N days/commits) suppresses speculative-generality — a one-entry registry two weeks
old is a plan; unchanged after 18 months it is a finding.

Tier 0 is **propose-only on every autonomy level**, except the narrow
provably-dead-private-code carve-out (§6), routed per-finding via `fixDisposition`,
not per-lens.

---

## 4. The gate matrix (per tier)

The council's load-bearing correction: **gate semantics must differ by tier.** A
single global gate set either reverts correct fixes (Tier 1/2) or lets behavior
changes through (Tier 3).

| Gate | Tier 1 (Structure) | Tier 2 (Correctness) | Tier 3 (Quality) |
|------|--------------------|-----------------------|-------------------|
| **Characterization test** | behavior-**preserving**: pinned test must stay green | behavior-**correcting**: red→green; the expectation flip is itself verified (§5) | preserving |
| **Coverage gate** | changed line must be executed by a test, else → propose-only | same | same |
| **Export/API snapshot** | may move exports the graph *proves* internal; frozen: `package.json` exports, entrypoints, anything dynamically imported | strict: unchanged | strict: unchanged |
| **Compiler/lint oracle** | must not introduce new diagnostics | same | same |
| **Multi-file allowed** | yes (coordinated, planned touched-set) | no (single file) | no |
| **Mutation test** | on touched region | mandatory for P0/P1 or thin coverage; scored against changed lines *and* immediate callers | optional |

The **behavior-correcting** semantics (Tier 2) resolve Fable-A/Codex-B's central
trap: a characterization test that pins the *current buggy* output must not be allowed
to fight the real fix. In Tier 2 the char-test pins everything *except* the path the
finding claims is wrong; that path uses red-then-green (the test encodes intended
behavior), and the expectation flip is a first-class object of adversarial
verification ("is this intended behavior really intended?").

---

## 5. The verification pillar (measured safety)

The council's biggest single gap: the fix path rests on "tests green", which proves
nothing if no test executes the changed line, or if the char-test is fictional. Four
layers turn "provably safe" from rhetoric into measurement. **Firewall (non-negotiable):
the characterization-test writer and the fix writer are structurally separated** — the
test is generated + committed in its own invocation that never sees the finding/fix
context, and `enforceTouched`'s allow-list forbids the fix step from ever editing a
test file (in either direction). This is what stops the loop from quietly reshaping a
test to reach green.

1. **Coverage-gated fixing (foundation).** Ingest real coverage (lcov /
   coverage-final.json / pytest-cov / go -cover / JaCoCo). If the fix's changed lines
   are not executed by any test, the fix is downgraded to propose-only — regardless of
   a green suite. Coverage also becomes a hotspot signal (uncovered × churn ×
   complexity).
2. **Execute-and-capture characterization tests.** For untested targets about to be
   refactored: run the *actual current code* on sampled/generated inputs and embed the
   literal captured output as the golden value (VCR-style for IO). Never let an LLM
   author expected values from reading source. Reject the generated test unless it
   (a) passes on unmodified code, (b) is bit-identical across N runs (determinism
   gate — non-deterministic targets → propose-only), and (c) actually executes the
   target symbol.
3. **Mutation-verified net.** Mutation testing on the touched region proves the net is
   not vacuous. Mandatory for P0/P1 and thin-coverage targets; scored against changed
   lines *and* immediate callers (a 100% score on the diff with untested affected
   callers is a false green).
4. **Compiler/type-checker/LSP oracle.** `tsc --noEmit`, `mcp__ide__getDiagnostics`,
   `mypy`, `go vet`, `clippy`, lint — sound, free, already installed, more precise than
   any regex smell. Dual use: high-confidence facts *and* the fastest fix gate (a diff
   that introduces a diagnostic is reverted before tests even run).

**Execution behavior-equivalence** (higher tiers, high leverage): for localized/pure
refactors, actually *run* old-vs-new on fuzzed inputs and diff outputs; add
property-based (fast-check/hypothesis) + metamorphic checks. This is the only true
behavior proof; a snapshot is only shape.

---

## 6. Safety invariants

**Classes that must NEVER be auto-applied** (propose-only regardless of green gates,
detected structurally not by test outcome):

- Auth/authz decision points, crypto / timing-safe comparisons, input
  validation/sanitization boundaries, secret handling.
- Any change converting a throw/deny/fail-closed path into a fallthrough/fail-open
  path (optional chaining, added defaults, `??`/`||` fallbacks around a decision that
  previously threw/denied).
- Concurrency/ordering-sensitive code: locks, queues, transactions, rate limiters,
  retry/backoff, sequential-await → `Promise.all`.
- Schema/migration code — detected by content shape (`up(`/`down(`, `knex.schema`,
  SQL DDL, ORM decorators), not path convention.
- CI/pipeline/build files for *any* vendor — detected by content shape (pipeline
  YAML/Jenkinsfile keys), not just a hardcoded `.github/` path.
- Generated code — detected by header/marker (`/* AUTO-GENERATED */`), not just
  `dist/`/`vendor/` path segments.
- **High fan-in / blast-radius files** (SSOT config, shared constants, global
  singletons) — cross-cutting *by definition* even when the diff is one file. Feed the
  already-computed fan-in/blast-radius score into fix-*eligibility*, not just ranking.
- Any target where char-test generation could not execute-and-capture deterministically,
  or where the coverage delta on changed lines is zero, or mutation score is below
  threshold.
- Anything the import/export graph could only place in its regex-based "candidate"
  bucket for the dependency check (dynamic imports, computed paths, barrel re-exports)
  — the localized-vs-cross-cutting classification is only as sound as that graph, and
  the graph is admittedly unsound.

**Content-aware never-touch.** Today `PROTECTED_RE` is path/name-based. Extend it with
content sniffing (migration/CI/generated/secret shape) *before* file content ever
enters a write prompt.

**Provisional ledger.** A ledger "fixed" entry must be revocable: mark it with the
exact commit SHA and status `pending-merge`; flip to durably-resolved only once the
branch actually lands on the base (observable via base-branch history); re-open
automatically if that SHA never merges or the branch is discarded. Otherwise the
audit's own memory silently suppresses re-detection of a defect that was later reverted
by hand.

**Automation-bias counter.** The report accompanying the branch must foreground, per
fix, exactly what was **not** verified (no coverage delta, no mutation score, char-test
generated-not-audited, protection is pattern-only) — make the gaps as visible as the
passes. The safer the gates *look*, the more a human skims; the report must fight that.

**Convergence (verdict ledger).** Re-findings that match a `refuted` verdict are
suppressed *before* re-verification, using **AST-anchored fingerprints** (normalized
hash of the enclosing symbol + finding category, not path+line) that survive
structure commits via the move/rename maps recorded on each Tier-1 commit. Without
this, loop-until-dry never reaches `K` dry passes and the de-facto stop is always the
budget.

**Runnability & baseline preflight.** Before pass 1: run the existing suite once,
record pre-existing failures/flakes. All gates thereafter mean "no *new* failures", not
"green" — otherwise one red legacy test makes the tool inert. If the repo has no
runnable test infra at all, the whole run degrades to propose-only, explicitly.

---

## 7. Token model

The corrected cost story (Codex-A, measured against this repo):

- **Deterministic-first is real** but the free tier and the auto-fixable tier are
  nearly disjoint: the static engine covers Structure (which is `propose-only`), while
  the tiers that actually get auto-fixed (correctness/perf/reliability) have the
  *weakest* static coverage. Report cost/finding split by lens × handling class — a
  blended "80% free" headline hides that the fix product is carried by the
  agent-heavy 20%.
- **"Loop cost decays toward 0" is false for the Structure/SSOT tier**, which runs
  first and, by construction, touches the highest-fan-in nodes (in this repo,
  `state.mjs` is imported by ~27% of lib files). Consolidating a hub has a
  *multiplicative* blast radius. Fix: bucket files by fan-in percentile; hub files
  (top ~10-15% or on the mandatory set) and all Structure-tier consolidations get **no
  incremental discount** — budget them as full passes. A **blast-radius circuit
  breaker** downgrades a single consolidation to propose-only if its dependent set
  exceeds ~20% of the remaining tier budget.
- **Dup invalidation has no import-graph channel.** `dup-detect` clusters by
  cross-corpus content windows; editing B can flip A's duplicate status though A never
  changed and doesn't import B. Maintain a **persistent `hash → {count, locations}`
  index**, updated by diffing only changed files' windows; a window-hash crossing the
  2-location threshold is the invalidation signal for the ssot/dup lens — decoupled
  from the import graph.
- **Incremental cache key** = own content hash **+** hash of *resolved* import targets
  (transitive dirty-propagation along the graph); lockfile, tsconfig paths, and
  `package.json` exports belong in the global key. A byte-identical consumer whose
  resolution changed is *not* clean.
- **Batch verification** — N same-lens findings per call, N verdicts back (the single
  highest-leverage token change; today `verify.mjs` is 1 call per finding). Reserve
  multi-agent adversarial verify for the 4 P0-consensus lenses (concurrency, security,
  data-integrity, config-cicd-security); single-pass verify for the other 8.
- **Lens-aware unit cost** — a unit whose only applicable lenses are P2/propose-only
  (testing, docs, architecture_ssot) should not cost the same premium-model call as one
  carrying a P0-consensus lens.

**Rough model, 50k-LOC repo (~200-250 files), order of magnitude:**

- First full run (cold): static ≈ $0; deep review over top ~15-20% hotspots ≈
  300-700k tokens; verify fan-out ≈ 150-500k (largest line item; multi-agent variant
  pushes to the top); fix writes ≈ 150-350k. **Total ≈ 0.6M–1.5M tokens.**
- Steady-state pass is **bimodal**: a leaf-file change ≈ 10-30k tokens (the
  "toward 0" claim holds); a hub-file change ≈ 20-40% of a full run. A few
  hub-touching commits/month dominate the cumulative bill.

---

## 8. Autonomy model (why aggressive-on-branch is safe)

Full autonomy runs on the branch; nothing waits on the human. The dial governs only
*commit vs. proposal*, both landing on the same branch without pause. The classes in
§6 stay proposals not because we ask permission but because they cannot be
machine-proven safe. The human's single intervention is to merge or discard ONE
branch — and the automation-bias report (§6) makes the unverified parts the thing they
look at first. Default = `aggressive`.

---

## 9. Roadmap

Safety-reordered from the build review (Grok-B), pulling the cheap load-bearing gates
forward (Grok-A/Codex-B) rather than deferring them to the end.

| M | Slice | New code | Dogfoodable |
|---|-------|----------|-------------|
| **M1** | **Safety foundation — deterministic fix-time gates**: export/API snapshot gate · content-aware never-touch · compiler/lint oracle gate (baseline-preflighted). All extend the existing gate stack in `audit-fix.mjs`. | `audit-snapshot.mjs`; `contentProtectionReason`; `detectOracleCmd` | ✅ today |
| **M2** | **Tiered ordering + Tier 0 logical-sense** (propose-only, predicate-driven, intent-defense). Prunes the queue → biggest token win. | `audit-tiers.mjs`, `logical_sense` lens, schema bump (`verdict`/`survivor`/`intentEvidence`/`gateEffect`) | ✅ |
| **M3** | **`audit fix --loop`** — fix-until-dry autonomous loop mirroring `audit-endless.mjs`; AST-anchored verdict ledger; fan-in-tiered cost; batch verify. The autonomous leap. | `audit-fixloop.mjs` | ✅ on this repo |
| **M4** | Autonomy dial + intake wiring · **provisional ledger** (resolve durably only after the branch merges; reopen if discarded) · changed-file re-audit (resolved-import cache key) · persistent dup index. | extend `ledger.mjs` + git ancestor check; intake in the command layer | |
| **M5** | **Coverage-gated fixing + firewalled execute-and-capture char-test generator + mutation.** Unlocks safe refactoring of untested code. | `audit-coverage-ingest.mjs`, `audit-chartest.mjs` | |
| **M6** | **Multi-file structure fixer** (the crux): transform-plan → planned-touched-set enforcement → all gates → per-transform commit. Top autonomy only. | `audit-multifix.mjs` | |

**Signal backlog** (parallel enrichments, cheap-first): git bug-fix/incident mining
(strongest defect predictor, ~hours — the history walk already runs) · spec/intent-drift
lens · learning from human accept/reject/revert · root-cause clustering + codemods
(fix once, not N) · SCA + license.

**Explicitly deferred:** auto-consolidation/SSOT merges stay propose-only until a
verified deterministic transform exists (do not weaken the safety rule for MVP); Tier 0
as an auto-*fixer*; the full incremental content-hash cache (only matters at 3000+
files — `fingerprint`/`ledger`/`baseline` already give cross-run recognition).

---

## 10. What ships today vs. what is new

Grounded in the repo. **Already production-grade** (reuse, don't fork): `audit-fix.mjs`
single-writer `enforceTouched` + test gate + clean-tree-mandatory + isolated branch +
revert-on-red + repo lock + no auto-merge + ledger close; `audit-endless.mjs` budget /
dry-streak / checkpoint / resume; `import-graph.mjs` exports/`hasDefault`/cycles/orphans;
`dup-detect.mjs`; `verify.mjs` (scoped P0/P1, single independent agent); `budget.mjs`
atomic charging; `ledger.mjs`; `audit-lenses.mjs` handling classes.

**New surface** (where the risk and this design live): the export snapshot gate,
tiering + Tier 0, the fix-until-dry loop, coverage ingestion, the firewalled char-test
generator, mutation, and the multi-file fixer. M1 starts with the pieces that are pure,
deterministic, and testable without a repo or an agent.

---

## 11. Council provenance

This design was pressure-tested by 6 parallel agents (max reasoning). Verdicts and the
one thing each is owed:

- **Fable-A (architecture)** — 3/5. Per-tier gate semantics; AST-anchored verdict
  ledger; divergent-dup merges are a correctness signal; baseline/runnability preflight.
- **Fable-B (logical-sense)** — Tier 0 is a distinct layer, belongs first, is the
  biggest optimization; its only autonomous power is to *not spend effort*, never to
  delete meaning.
- **Codex-A (tokens)** — 3/5. "Cost → 0" is false for the SSOT tier; dup invalidation
  needs its own global hash index; batch verify; fan-in-tiered cost.
- **Codex-B (safety)** — 2/5 as stated. The char-test self-certification trap is the
  central danger → firewall the test writer from the fix writer; content-aware
  never-touch; provisional ledger; automation-bias report.
- **Grok-A (missing)** — the dynamic verification pillar is the biggest gap
  (coverage → char-test+mutation → execution-equivalence); three unused signal classes
  (intent/spec, runtime/observability, learning); compiler/LSP oracle nearly free.
- **Grok-B (build)** — don't rebuild; wrap the existing safe fixer in a tiered loop;
  multi-file + char-test are the last two, separately gated milestones.
