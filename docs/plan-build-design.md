# `council plan` + `council build` — multi-model design synthesis

Synthesized from a 4-model-family design deliberation (Opus + Fable workflow judge; Grok fleet D1–D6;
Codex direct D1–D6). Strong convergence. This is the implementation spec for the feature.

## Two commands over ONE shared PlanSpec

- **`council plan <request>`** — a MULTI-MODEL DESIGN DELIBERATION → a validated PlanSpec artifact.
  READ-ONLY (no repo/state writes). R1: every active seat proposes independently (firewalled). R2: every
  seat peer-critiques the merged proposal set (all-to-all). R3: one synthesizer (default claude) merges the
  ranked plans into ONE schema-validated PlanSpec. Emits markdown (human) + JSON (for `--from`).
- **`council build [--from <plan.json>] <request>`** — autonomously implements a PlanSpec on an isolated
  branch/worktree, one ordered step at a time, each step gated (below). Aborts the whole run on the first
  gate failure (steps are DEPENDENT). Never auto-merges.

## Modules (new; pure + injectable; zero deps)

- `plan-spec.mjs` — the PlanSpec contract. `parsePlanSpec` / `validatePlanSpec` (fail-closed) /
  `normalizePlanSpec` / `planStepTouched(step)` (exact create∪edit∪test path set) / `renderPlanMarkdown`.
- `plan-deliberate.mjs` — the design deliberation. `runPlanDeliberation` / `synthesizePlanSpec`. GENERALIZES
  `solve.mjs`'s R1/R2 to `activeSeatNames`/`makeSeatRunners` so claude (spawned) + every OpenRouter seat
  propose AND critique. Reuses solve's pure `parsePlanDoc`/`parsePlanCritique`/`rankPlans`/`collectRepoHints`
  + the `r1-proposal.md`/`r2-plan-critique.md` prompts. Adds the R3 synthesis + `validatePlanSpec` (retry
  once with validation errors appended). **Fixes solve's six-eyes bug** (solve.mjs:302 critiques codex+grok
  only, claude via file, no OpenRouter). `solve.mjs` stays a compatibility facade (its tests untouched).
- `build-step.mjs` — the per-step applier + gate ladder (greenfield multi-file analogue of runAuditFix's
  inner unit). `runBuildStep` / `makeStepReviewer` / `enforceStepTouched`. Pure control flow; all I/O injected.
- `build.mjs` — the orchestrator. `runBuild` / `makeBuildGit` / `renderBuildReport`. Mirrors runAuditFix's
  OUTER structure (clean tree mandatory, repo lock, isolated branch off clean base, base never touched,
  final integration gate, return-to-base) but does NOT call runAuditFix.
- Additive change to `audit-patch-reviewer.mjs`: `makePatchReviewer` gains an optional `opts.buildPrompt`
  (default = the single-file patch prompt) so a step's multi-file diff is reviewed with a structure-gate-style
  multi-file prompt while the audit path stays byte-identical (guarded by a test).
- Extract a shared path-safety primitive out of `structure-gate.mjs` (isUnsafePath / PROTECTED_RE) so
  plan-spec and structure-gate share it (structure-gate behaviour unchanged; test path allowed only when the
  step declares it role:test).
- CLI: `council-companion.mjs` `handlePlan` + `handleBuild` following handleAudit's wiring order
  (probeBackends → loadPolicy → mergeOptionsWithPolicy → attachOpenRouterSeats). Skills + commands/*.md.

## PlanSpec (fail-closed)

```
{ schemaVersion:1, request, requestHash, baseCommit,
  steps:[ { id (^[a-z][a-z0-9-]{0,63}$, unique), title, intent,
            files:[ { path (repo-relative POSIX, safe, unprotected), action:create|edit, role:source|test } ],
            test:{ files:[recognized test path, in files with role:test], intent },
            dependsOn:[earlier step ids, acyclic] } ],
  risks:[{id, description, mitigation}], testStrategy:{ perStep:"full", final:"full" } }
```
Validation: strict JSON, no unknown keys, bounded sizes, ≥1 step, unique/acyclic ids, non-empty files,
known actions, create ⇒ path absent at step start, edit ⇒ existing regular file, test path allowed only when
present in files with role:test (relaxes structure-gate's test-ban ONLY for the declared test), all other
protections (CI/git/deps/lock/secrets/state) stay. `planStepTouched(step)` = exact create∪edit∪test set,
immutable after synthesis — the capability boundary for the step's writer + commit.

## Per-step build gate ladder (fail-closed; abort-on-fail)

0. **Preflight**: git repo, named base branch, CLEAN tree, HEAD===baseCommit, detectable test command, all
   required §6 seats reachable (requiredPatchSeats: built-ins + configured OR), GREEN baseline (oracle+full
   suite). Repo lock. Fresh disposable worktree on `council/build-<slug>-<sha>`; base never checked out.
1. **Per-step snapshot** = git.head(); monotonic budget (steps/attempts/model-calls/wall-clock/diff-bytes).
2. **Revalidate step vs tree**: create absent, edit exists+regular, no symlink escape, paths safe/unprotected,
   impl∩test disjoint, ≥1 test target.
3. **TEST-FIRST author**: a separate write-broker'd call authors ONLY the test files (data-only; no model FS
   tools). Static firewall (chartest `parseCharTest`: node:test+node:assert only, discriminating assertion,
   no child_process/fs/net/eval/dynamic-import). Hash the test bytes (immutable for the step).
4. **RED-before**: run the test-only patch against the pre-impl tree ≥3× under the node permission sandbox;
   require the declared cases to FAIL at ASSERTION level (not syntax/loader/crash/timeout), deterministically,
   with a stable non-empty observable. A tautological/always-green test is rejected here.
5. **IMPL author**: write-broker'd call authors ONLY the impl files (cannot touch the hashed test).
6. **enforcePlannedTouched**: actual changed set === planStepTouched (exact; reject unexpected/missing/
   untracked/ignored). Content-protection before+after. snapshotViolation on edit files (API) per declared effect.
7. **GREEN-after**: the identical hashed test passes ≥3× deterministically → the ONLY difference vs RED is the
   impl bytes. **Changed-line coverage** (chartest `changedLinesCovered`, innermost-wins) over every added/
   modified impl line. (Mutation gate: optional/deferred.)
8. **Full suite** green on the candidate; rescan worktree manifest (no undeclared/ignored artifacts).
9. **§6 council**: every required seat independently reviews the SAME complete non-truncated staged multi-file
   diff + step + test + RED/GREEN evidence (nonce-fenced untrusted), from an instruction-isolated cwd.
   `evaluatePatchVerdicts(..., {required: requiredPatchSeats})` must be unanimous; missing/dissent/abstain/
   parse-error/timeout vetoes. Oversized diff = veto (never review a truncated tail → split the step).
10. **Reviewed-byte binding**: after async review, re-check changed set + testDigest + stagedDiffHash byte-for-
    byte === reviewed; stage only declared paths; `commitIndex` the already-staged index. One commit/step.
11. **Rollback**: any gate fail → resetHard(snapshot)+clean -fd (verified) → ABORT (dependent steps). Failed
    restore ⇒ stranded.
12. **Final integration**: full suite on the whole branch; keep the isolated branch for human review; return to
    base; never merge.

## Safety v1 (minimum-safe — Codex D6 + Grok D6)

Autonomous ONLY for: pure Node ESM **library** steps, ≤6–8 ordered steps, ≤2 attempts/step, disposable
worktree, model output as DATA (no direct FS/shell/network/MCP tools for the writer), whole-build atomic
rollback, hard budgets, node permission sandbox on every test run. **No escape hatches**: no --allow-untested,
--skip-council, dirty-tree, reduced-council, arbitrary shell test command, auto-resume/supervise, auto-merge.
`--from` requires requestHash + baseCommit match. HUMAN-gated / DEFERRED: model-authored gating tests without
red-before-green proof, deletes/renames/symlinks/binaries, dependency/lock/CI/config/migrations, secrets,
auth/crypto/concurrency/data-integrity, network/process/env features, cross-cutting structural transforms,
OpenRouter source egress when the user hasn't consented, any platform where hard test containment is unproven.

## Open design tension (resolve at build time)

Codex D3 designs model-authored red-before-green tests (+ mutation) as the oracle; Codex D6 argues v1 should
use HUMAN-OWNED, plan-hash-bound test bytes and defer model-authored gating tests. Resolution: v1 allows
model-authored tests BUT only when the red-before-green + discriminating-assertion + §6 gates all hold (the
harness, not the model's assertion, is the oracle — same principle as the hardened chartest gate). A
`--tests human` mode (human-supplied test bytes) is the stricter opt-in.

## CLI / artifact / skills

`council plan [--json] [--synthesizer <seat>] <request>` → PlanSpec md+json (saved under the state dir).
`council build [--from <repo-relative plan.json>] [--json] [--dry-run] <request>` → build report
(per-step snapshot/paths/verdicts/commit/rollback, final integration, returnedToBase, stranded). Add
`.claude/skills/council/plan` + `build` and `commands/plan.md` + `build.md`, consistent with council:* skills.
