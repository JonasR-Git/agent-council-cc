# Tier-scoped Epoch-Sweep + durable run-wide cell cursor — CONVERGED DESIGN

> Design converged by council `council-08897fbf` (Claude + Codex + Grok, R1 independent + R2 critique;
> 20 consensus findings). This is the AUTHORITATIVE build spec. Correctness of the coverage guarantee
> outranks token saving. Zero deps, .mjs, node:test, six-eyes intact (every frozen model runs every
> scoped lens of the tier).

## Problem (live-observed + engine-mapped)
`audit fix --loop` re-reviews a blind modulo slice of the file window over ALL lenses every pass, though it
only processes the CURRENT tier's findings. (1) Waste: an empty/propose-only tier still reviews the whole
~2000-cell matrix. (2) **Coverage hole**: the window is a `(fullPasses*maxUnits) % nonTestCount` cycle (NOT a
coverage set) + a `capCells` prefix that drops the tail unpersisted; tier-advance gates on `coverage.ran`,
not real coverage (audit-fixloop.mjs:793-821 concedes the skip). This design REPLACES that with a provable
100%-per-tier coverage guarantee.

## Verified engine facts (file:line)
- Cell = `(model, groupId, file, chunkIndex)`; `cellKey = JSON([model,groupId,file,chunk])`
  (audit-cell-scheduler.mjs:26). **Identity is POSITIONAL — chunk is an index, NO content hash.**
- Enumeration `enumerateCells(files, groups, models, chunksOf, factsOf)` (audit-cell-scheduler.mjs:37) at
  audit-grouped-review.mjs:100. `groups` carry `.lenses`. chunkCache built at grouped-review.mjs:80-97.
- Bounding: file window `selectUnits(...).slice(off, off+maxUnits)` (audit-review.mjs:66) with
  `off=(fullPasses*maxUnits)%nonTestCount` (audit-fixloop-deps.mjs:168, persisted windowState/windowPasses)
  + cell cap `capCells` (audit-cell-scheduler.mjs:69, drops budget tail, NOT persisted).
- `makeReviewCursor`/`reviewCursorPath` (audit-midpass-guard.mjs:119/129) = flat set of positional
  cellKeys, best-effort, reset on fresh run (audit-fixloop.mjs:368) AND after every completed pass (:750/831).
  Mid-pass quiesce→resume bridge only.
- Tier NOT known at enumeration; post-hoc filter `actionable.filter(tierOfLens(f.lens)===currentTier)`
  (audit-fixloop.mjs:592). review() (audit-fixloop.mjs:460) passes no tier; adapter forwards full preset
  (audit-fixloop-deps.mjs:203). Per-file path `doPerFile` when `!lensGroups` (audit-fixloop-deps.mjs:115).
- Coverage signals over the SCHEDULED set only: passComplete/complete/starved (audit-grouped-review.mjs:278-283),
  `ran:!starved` (:342), `sixEyesComplete(triplesOf(cells))` (audit-cell-scheduler.mjs:104,121,365,379).
  noContent/unsupplied files filtered from `supplied` (grouped-review.mjs:72-107).
- No exported `lensesOfTier`; use exported `TIERS[tier].lenses` (tier id === array index 0..3).
- Just-committed F-A (promote-on-test-red) + F-B (capability-aware FIRST_TIER; under `--structure-auto-apply`
  tiers 0/1 are fix-staged) must be honored.
- CAVEAT (codex): council-companion builds the codebase model ONCE (council-companion.mjs ~2232) and
  makeFixLoopDeps captures model.files — a fix that CREATES/DELETES/RENAMES a file is invisible to
  re-enumeration over that object. The manifest MUST be rebuilt from disk (git tree), not model.files.

## CONVERGED DESIGN

### Building block 1 — tier-scoped enumeration (via INTERSECTION projection, not `some()`)
Thread a new `tier` field through `review()` (audit-fixloop.mjs:460) → adapter (audit-fixloop-deps.mjs:203)
→ `runGroupedReview` options, and scope groups BEFORE `enumerateCells` (audit-grouped-review.mjs:100):
- `scopeGroupsForTier(groups, tier)` (in the new module): for each group, `lenses' = group.lenses ∩
  TIERS[tier].lenses`; DROP empty groups; retain `focus`; assign a STABLE derived groupId `${g.id}@t${tier}`
  (the ledger key depends on it); `resolveLensGroups(..., {requireCover:false})`; validate the result covers
  exactly the tier's registered lenses. Do NOT use `.some()` (keeps straddling groups whole → reviews
  off-tier lenses → poisons the denominator) and do NOT unconditionally switch to the `tier` preset (it
  collapses fine's aspect-focused depth into one shallow group/tier). For the built-in single-lens FINE
  groups this is a no-op projection; it is correct for any custom/mixed group.
- `tier == null/undefined` → EXACTLY today's behavior (full preset) — backward compatible.
- Six-eyes intact: every frozen model runs every scoped lens of the tier; `sixEyesComplete` works on the
  reduced matrix (no full-matrix assumption).

### Building block 2 — durable run-wide sweep ledger with a SEALED MANIFEST denominator
**D1 (decided): a SEPARATE new module `audit-tier-sweep.mjs` + `audit-tier-sweep-cursor.jsonl`.** Do NOT
extend makeReviewCursor (best-effort, per-pass reset, positional key — incompatible with a
correctness-critical run-wide denominator). The mid-pass cursor is left UNTOUCHED (still the quiesce bridge).

**The denominator (THE CRUX): a once-per-(tier,epoch)-sweep SEALED MANIFEST.** A done-ledger alone proves
only "all VISITED cells done" = the passRan bug reborn. So:
- At the FIRST pass of a `(tier, epoch)` sweep, build the manifest ONCE using the SAME chunkCache/chunksOf
  path + noContent/unsupplied filter as `enumerateCells→supplied` (mirror grouped-review.mjs:72-107). For
  every eligible (non-test, readable, non-oversize) file record `{file, fileRevision, chunks:[{i,startLine,
  endLine,chunkHash}]}`; then a `manifest-seal` record.
- `expected(tier) = |frozenReviewers| × Σ_f ( chunkCount(f) × |scopeGroupsForTier(groups,tier)| )` — adjust
  per-group if focus scoping ever makes a group skip chunks.
- **Unreadable / oversize / unsealed files are explicit DEBT that PREVENTS completion** — never a zero
  contribution (that would allow false-advance).
- Cost: one read+chunk+hash per sweep (local I/O, trivial vs model calls), NOT per pass — amortized.
- Rebuild the manifest from the git working tree after each fix batch (see D6), not from captured model.files.

**D2 (decided): SHA-256 (node:crypto) over the exact `chunkSource(...).text`, computed at MANIFEST/
enumeration time.** A non-crypto hash (FNV/hashLite) has a false-CLEAN (false-done) collision direction —
unacceptable for a coverage-correctness key. node:crypto is a built-in (zero deps). Compute at enumeration
(chunk text in hand), carry on the cell, `markDone` writes exactly that value (avoids the markDone-time
TOCTOU where a mid-pass file change would record a hash for text no model reviewed). NO newline normalization
(the chunker output IS the reviewed payload).

**The canonical sweep key MUST include groupId + full identity** (else distinct fine groups false-satisfy):
`sweepCellKey = JSON.stringify([schemaV, epochHash, tier, groupSpecHash, groupId, reviewerSetHash, modelSeat,
modelIdentityHash, posixFile, chunkIndex, chunkHash])` where:
- `groupSpecHash` covers id + ordered lenses + title/focus + prompt contract.
- `modelIdentityHash` covers backend/model/effort (NOT just seat name).
- `posixFile` = repo-relative path, `replace(/\\/g,'/')` at ONE place in the key-builder (Windows `\`
  otherwise makes the same cell a different key across platforms/invocation styles). node:test the
  determinism (`\` and `/` input → same key).
- Freeze the reviewer set at epoch creation: a temporarily-unavailable seat stays OWED, never silently
  shrinks the denominator.

**D4 (decided): global epoch = a config FINGERPRINT in the ledger HEADER (not per-cell, not per-row-key).**
`epochHash = sha256({schemaVersion, chunkerVersion/settings, tier→lens map/registry version, scoped group
specs, prompt version, frozen reviewer/model identities, deep flag, preset id, only flags that change the
reviewed payload})`. Content edits do NOT bump the epoch (local chunkHash handles them). Epoch mismatch on
resume = hard config mismatch → fail-closed: keep old rows tagged with the old epoch (audit trail), count
them ZERO toward coverage, start the sweep fresh (re-review direction). reviewerSet + epoch live in the
HEADER row, not every done-row (avoids bloat + a row-level-mismatch bug class).

**Ledger records (append-only jsonl, own module):** header `{v,type:'header',runId,baseBranch,baseHead,
epochHash,reviewers,tierPlan}`; file manifest `{v,type:'file',seq,file,revision,chunks:[{i,start,end,h}]}`;
manifest seal `{v,type:'manifest-seal',seq,digest,fileCount}`; cell done `{v,type:'done',seq,k,pass}`;
tier clean `{v,type:'tier-clean',seq,tier,manifestDigest}`.

### Tier-advance rule (replaces passRan) — D3 + D6
**D3 (decided): REPLACE the modulo window (behind a mode flag), do not filter it.** Filtering a positional
slice to "unreviewed" keeps windowState/fullPasses as a second source of truth that desyncs from the ledger
and produces empty passes. In sweep mode:
- Per pass: pending-driven selection — files with ≥1 pending cell in deterministic `selectUnits` order up to
  `maxUnits`, then schedule exactly their pending cells. `capCells` still caps to whole triples; the uncapped
  remainder is simply NOT marked done → stays pending. **OWED = Manifest − Done comes for free** (the
  dropped budget tail is now automatically persistent). A starved pass (0 schedulable) must NOT advance the
  tier or increment tierDryStreak.
- `changedFiles` (localized passes) becomes SCHEDULING PRIORITY (touched files' pending cells first, then
  global pending), never a restriction on the expected universe.
- Blast radius: the only offset-callsite change is audit-fixloop-deps.mjs:168 behind the mode flag;
  windowState/windowPasses stay in the checkpoint (written, ignored in sweep mode) so legacy/old checkpoints
  still work. Sweep mode REQUIRES the grouped path (`lensGroups` set); fail-closed if a sweep flag is on
  without grouped review (the per-file path has no cell ledger).

**tierAdvanceAllowed(sweepCursor, tier)** iff ALL of: (a) `pending(tier) === 0` under the current epoch
(includes cells re-opened by fixes); (b) no owed/dropped/unreadable/oversize debt remains; (c) **fix-free
settle**: the last gate/fix cycle over that tier's CURRENT manifest applied ZERO fixes (any fix invalidates
the claim); (d) the tier's auto-fixable dry streak ≥ dryStop (preserve the existing consolidation semantics).
Wire at audit-fixloop.mjs:798-821, replacing the passRan gate for sweep mode. `passRan` survives ONLY to
ignore starved no-op passes. `coverageIncomplete` becomes DERIVED: `pending(tier) > 0` (or terminal with any
global pending) — the consumers (tier-advance gate, F-A re-entry) keep their contract, the signal is just
precise instead of heuristic.

### D6 — fix invalidation, re-entry, and the livelock circuit-breaker
- After each fix batch, derive the changed-path set from VERIFIED before/after git tree IDs (not trusting
  `fx.changedFiles`/the audit-fixloop.mjs:760 fallback). Refresh added/deleted/modified file manifests, reset
  ONLY those per-file frontiers, retain done credit solely for identical current keys (chunkHash match).
- Mark every already-started affected tier dirty; at the pass boundary re-enter the earliest dirty FIXABLE
  tier (mirror F-A/finding re-entry, but trigger on `sweepCursor.tierPending(T) > 0` after a fix, not only on
  new findings — fixes can invalidate without producing new findings).
- Extend `audit-findings-store.mjs` records (currently no source-cell identity, ~:88-112) with `sweepCellKey`
  + epochHash + fileRevision; EXCLUDE stored findings whose source key is no longer expected (else the
  append-only store re-offers stale findings after content moved).
- **Livelock circuit-breaker (codex — refutes "content-hash is self-limiting"):** a test-GREEN edit that
  changes content WITHOUT resolving the finding is caught by neither seenProposed nor the F-A test-red
  counter → it can be re-fixed forever. Deterministic breaker keyed by `(tier, file, beforeFileHash,
  afterFileHash, findingFingerprint)`: recurrence of a prior file-hash transition, or K `(file,tier)`
  invalidation cycles with no net finding reduction → STOP auto-fixing that file, promote to proposal, flag
  for human review; never advance on churn.
- Chunk-shift handling: an early edit shifts subsequent chunk indices/hashes → re-chunk the file, match
  `(index, hash)` against done-rows; identical prefix stays done, the shifted tail is re-reviewed. Over-review,
  never under-review (fail-closed). **DOCUMENTED COST**: a fix early in a large file re-opens all its later
  chunks across all tiers/models — conservative-correct but a real amplification; combined with fix-free
  settle it can strain budget ceilings on fix-heavy runs. Accept + budget it in v1; content-defined
  re-chunking is a deferred mitigation.

### F-B interaction — a checkpointed TIER PLAN (else tier-scoping breaks six-eyes)
Tier-scoped enumeration alone would NEVER review tiers 0/1 (FIRST_TIER≥2), violating every-model/every-lens.
Use a checkpointed tier plan:
- WITH `--structure-auto-apply`: `[0,1,2,3]` are all FIX stages.
- WITHOUT: FIX stages `[2,3]`, then REPORT-ONLY final-content sweeps `[0,1]` — advance on the same 100% rule
  but never call the fixer (findings surface as proposals). Preserves structural discovery AND coverage.
- `logical_sense` (tier 0) is never review-sourced; its report-only sweep is quick.

### D5 — fail-closed resume + fsync ordering + checkpoint handshake
- **fsync ORDER (load-bearing):** findingsAppender flush+fsync FIRST, THEN ledger done-record append+fsync.
  A crash between = cell stays pending = re-review (dup-safe via finding-key dedupe). The reverse order would
  mark done while findings are lost → PERMANENT finding loss.
- markDone counts as done ONLY after a successful fsync; a persistence error HARD-STOPS sweep mode (unlike
  makeReviewCursor's best-effort swallow).
- Ledger lives in the audit-state dir, NEVER the working tree (protected-paths / --pause-at-5h intact),
  written under the existing run-lock (one-writer).
- Checkpoint carries `sweep:{v, runId, epochHash, ledgerSeq, manifestDigest, tierPlanIndex}`. On `--resume`:
  run the existing dirty-tree/branch guard FIRST (evaluateResumeGuard — never stash/reset), THEN require a
  matching header/epoch/tier-plan + verify branch/tree + manifest hashes. Asymmetry: ledger-AHEAD-of-checkpoint
  = safe (replay the ledger as authoritative after validating run+tree); checkpoint-ahead-of-ledger, missing
  ledger, interior corruption, epoch mismatch, or unexplained tree drift = ABORT without touching the worktree.
  A torn final jsonl line is ignored → that cell re-reviewed.
- Load tolerance: corrupt-tail recovery (drop a truncated last line, keep the rest); a dropped row = cell
  pending = fail-closed toward re-review.

### Terminal semantics (budget/pass ceiling BEFORE 100%)
Explicit fail-closed exit status `coverage incomplete` with persisted per-tier debt. A later run with an
identical epochHash carries the open debt forward (the ledger is authoritative; the denominator does NOT
restart at zero). Never silently fall back to passRan advancement.

### Migration / default
Stage behind an `--epoch-sweep` flag (or `options.tierSweepCursor`), legacy byte-identical when off. Sweep
mode implies grouped review + per-tier + rejects `--flat`. The active mode is pinned in the checkpoint
(`sweep:{...}`) — resume never flips it; a `--resume` of a no-sweep checkpoint continues in legacy mode for
that run (modulo + ledger do not compose mid-run). After the guarantee is proven by tests, a follow-up flips
the default ON for `fix --loop --per-tier` grouped runs (the skip hole is a confirmed correctness bug; a
knowingly-unsound default is itself a fail-open).

## Staged, independently-testable implementation
1. **Pure module `audit-tier-sweep.mjs`**: SHA-256 hashing, canonical POSIX key builder, `scopeGroupsForTier`,
   manifest build (mirroring supplied/noContent), epochHash config-fingerprint, ledger append/load with
   torn-tail recovery, `pending()/tierPending()/expected()`; fs+clock as INJECTED ports (determinism). Units:
   fine/tier/mixed-group scoping, Windows-path canonicalization, collision fail-direction, corrupt tail.
2. **BB1 tier-scoping**: thread `tier` through review()→adapter→runGroupedReview→scopeGroupsForTier before
   enumerateCells. Tests: empty tier enumerates only tier lenses; sixEyesComplete on the reduced matrix;
   report-only stages for the tier plan.
3. **D3 window replacement** behind the mode flag at audit-fixloop-deps.mjs:168 — pending-driven selection;
   capCells tail stays pending + continues next pass. Property test: union of cells planned across passes ==
   manifest (NO skip); no cell replanned at an unchanged hash (no waste).
4. **Tier-advance rewire** (audit-fixloop.mjs:798-821): pending==0 + fix-free settle + F-A re-entry via
   invalidation + `(file,tier)` circuit-breaker + git-tree-diff invalidation + findings-store sweepCellKey.
5. **Checkpoint/epoch/resume/pause-at-5h**: fail-closed cases (epoch mismatch, missing sweep block, corrupt
   tail, ledger-ahead vs checkpoint-ahead).
6. **Default handling + docs** + the overarching coverage-guarantee property test as a regression guard.

Existing legacy tests MUST stay byte-compatible with the flag off. The highest-value assertion is
adversarial: **no tier may advance while any expected current-content key is absent, regardless of pass count
or `coverage.ran`.**
