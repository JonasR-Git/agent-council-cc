# Audit schema — enterprise-grade `/council:audit`

> Status: **design, council-hardened.** Produced by dogfooding `/council:plan`
> (job `council-8832cc0a`, Codex + independent spawn-Claude; Grok unavailable).
> Codex's XL/0.92 plan is the skeleton; this doc grafts the framing + phasing and
> resolves the five blockers Codex raised. Nothing here is implemented yet.

The surface is **two commands**: `/council:audit` (self-driving whole-project review
→ a prioritized **risk register**) and `/council:audit fix` (an agent team fixes only
**confirmed, localized** findings). `static` / `review` / `endless` become internal
phases, not public modes.

The inviolable rule stays: **static/regex facts are candidates, never authority —
detect → propose → verify → fix only the provably-safe + tested.** Cross-cutting /
SSOT / architecture / migrations / dependencies / CI / secrets are **propose-only
regardless of risk score.**

---

## 1. Contracts (three schemas + a finding lifecycle)

Separate the audit contract from the permissive generic review-findings contract.
Add, at `schemaVersion: 1`, validated by the existing zero-dep validator (extended
only for the JSON-Schema constructs actually used; unknown enum values rejected):

- **`audit-policy.schema.json`** — lenses, per-lens routes, external tools, coverage
  guarantees, standards profiles, gate rules. Lives in a rich `.council-audit.json`
  (the flat `.council.yml` parser can't express nested lens/tool policy); `.council.yml`
  stays for shared reviewer settings.
- **`audit-finding.schema.json`** — the canonical finding (below).
- **`audit-report.schema.json`** — snapshot, risk register, area×lens coverage matrix,
  governance decisions, metrics, provenance, gate status.

**Finding lifecycle** (a state machine, not a flat list):

```
candidate → verification_required → confirmed → fixed
                     ↘ refuted            ↘ inconclusive
```

A canonical finding requires: stable `ruleId` + semantic `fingerprint`, `lens`/
`category`, `lifecycle` state, `severity`, independently-rated `likelihood` /
`blastRadius` / `exploitability` **with rationales**, calibrated `confidence`, derived
`risk`, ≥1 `path:startLine` location, a concrete `failureScenario`, `evidence`/
`provenance`, `standards` tags, `scope`, `consensus` status, `owners`, baseline/waiver
state, and `fixDisposition`. **A fact without a line and a failure scenario stays an
observation** — it cannot enter the gate or the fix queue.

## 2. The twelve-lens registry

Versioned data (not scattered logic). Each lens declares: detection sources,
severity **ceiling**, consensus-required, handling class, standards tags. Static
regex candidates are capped at **P2 until independently verified**; a ceiling is
exceeded only by **reclassification into the lens of the proven impact**.

| Lens | Detection | Ceiling | Consensus | Handling | Standards |
|---|---|:--:|:--:|---|---|
| **correctness** | static control-flow/error + agent trace + tests/linters | P1 | no | localized fix; cross-module propose | CWE-670/691/703 |
| **concurrency_resources** | async/lock/timer/child-proc/resource + agent schedule + stress tests | P0 | yes | fix conditional; protocol propose | CWE-362/400/404/772/833 |
| **security_secrets** | source/sink/secret + adversarial exploit review + sec tools | P0 | yes | fix conditional; auth/rotation propose | OWASP A01/02/03/05/07/08/10 |
| **data_integrity** | txn/validation/serialization/destructive-write + failure trace + tests | P0 | yes | fix conditional; schema/migration propose | CWE-20/190/345/367; A04/A08 |
| **architecture_ssot** | import graph, duplication, cycles, layering, config-sprawl + global reduce | P1 | no | **always propose-only** | AC-ARCH/SSOT; opt SOC2 CC8.1 |
| **performance** | complexity/fan-out/sync-I/O/allocation + hot-path reasoning + benchmarks | P1 | no | localized tested fix | CWE-400/770 |
| **reliability_observability** | swallowed failures, retry/timeout/backoff, cleanup, logging, health + smoke | P1 | no | localized fix; ops redesign propose | CWE-703/754; opt SOC2 CC7.2/7.3 |
| **testing** | source→test mapping + parsed coverage + gap analysis | P2 | no | localized test work | AC-TEST; opt SOC2 CC8.1 |
| **dependencies_supply_chain** | manifest/lockfile + reachability + opt-in `npm audit` | P1* | yes | **propose-only** (protected) | CWE-1104; A06/A08; opt PCI 6.3.2 |
| **compliance_governance** | sensitive-data/license/retention hints + policy analysis | P1 | yes | **propose-only**; not an attestation | PRIVACY + enabled SOC2/PCI |
| **docs_maintainability** | API/config/doc drift, TODO, ownership + review + doc/link checks | P2 | no | localized doc fix; arch-doc propose | AC-DOC; opt SOC2 CC2.2/8.1 |
| **config_cicd_security** | workflow perms, unpinned actions, unsafe interpolation, secret exposure + exploit review | P0 | yes | **propose-only** (protected CI/secrets) | CWE-16/78/94/829; A05/A08 |

\* active-exploitation dependency findings reclassify under `security_secrets`.

## 3. Risk model (evidence-backed, auditable)

```
S = {P0:10, P1:7, P2:4, nit:1}
L,B,E ∈ 1..5   (likelihood, blast-radius, exploitability — each independently justified)
rawRisk        = 100 · (S/10) · (L/5) · (B/5) · (E/5)
confidenceF    = 0.25 + 0.75·C
calibratedRisk = round(rawRisk · confidenceF)     # keep every component — the number is auditable
```

Models may *propose* L/B/E, but the **engine derives confidence C from evidence
state**, capped:

| Evidence | C cap |
|---|---|
| regex-only | ≤ 0.35 |
| deterministic/external fact, reachability unproven | ≤ 0.55 |
| one evidence-backed finder | ≤ 0.65 |
| independent agreement | ≤ 0.80 |
| survived adversarial verification | ≥ 0.85 |
| reproducing test/trace | ≥ 0.95 |

**Never silently downgrade severity because confidence is low** — sort the register by
gate-state, then calibratedRisk, severity, confidence. **All P0/P1 and all
consensus-required categories get a lens-aware refutation** by a model that did *not*
originate the finding (security → exploit, concurrency → interleaving, data →
loss/corruption, compliance → challenge the control). Refutation marks `refuted` and
drops it from the gate without deleting history. *(Resolves blocker 4: verify covers
P0/P1 regardless of consensus.)*

Report the **observed false-positive rate** = `refuted_fp / (confirmed + refuted_fp)`,
overall and per lens/detector, with a zero-dep **Wilson 95% interval + sample size** so
sparse data isn't shown as precision.

## 4. Coverage — bounded guarantee, honest accounting

*(Resolves blocker 3: "guarantee" is precisely bounded, not overclaimed.)*

- **Inventory every** tracked+untracked non-ignored file — incl. unsupported languages,
  manifests, lockfiles, CI/config, public docs. Each detector declares its supported
  file classes, so **`mapped` never implies `parsed`**.
- **Mandatory set** = union of: configured critical globs, package `exports`/`bin`,
  plugin manifests + command entrypoints, externally-reachable exports, high fan-in
  modules, auth/crypto/secret/network/process/fs/deserialization sinks, persistence +
  migration code, dependency manifests/lockfiles, CI/deploy config.
- **Guarantee**: every mandatory `(file, lens, snapshotHash)` has all source intervals
  supplied in bounded overlapping chunks, ≥1 parseable review per required lens, and
  required verification done. **Budget exhaustion → `gate.status = indeterminate`**,
  never a false "complete."
- **Tail** ranked by `H = 100·((e+(1-e)C)(e+(1-e)Ch)(e+(1-e)B)(e+(1-e)Sm))^¼`, `e=0.05`
  (complexity, churn, blast-radius, smell-density); mandatory always outranks H.
- **Record** mapped files/LOC, statically-analyzed, agent-supplied intervals,
  successfully-reviewed intervals, external-tool scope, reused exact-hash results,
  sampled tail, and **uncovered files with reasons**.
- **Incremental** reuse key = content + dependency-closure + policy + detector +
  lens/prompt + model + tool-version hashes; manifest/public/security-policy changes
  invalidate the affected guarantee set.
- A deterministic **completeness reconciliation** + an independent **agent critic** that
  may *add* missed mandatory paths but can **never upgrade coverage itself**.

## 5. Council-native routing (per-lens roles)

Routing is per-lens **roles**, not one reviewer list: `primaryFinder`,
`diverseSecondFinder`, `adversarialVerifier`, `completenessCritic`, `fallback`, plus
pinned model id, CLI version, prompt hash, effort, timeout, max-calls. Defaults:
Codex → code-tracing lenses (correctness, concurrency, data, performance, testing);
spawn-Claude → architecture, compliance, docs, governance synthesis; the *other* model
verifies; security/config get **both** a code-tracing and an exploit pass. Only the
**spawn** backend counts as an independent worker (session Claude does not). Loop the
two model families until **two dry rounds per area/lens** or the budget. A missing
required verifier/consensus participant → `inconclusive`/`indeterminate`, **never
synthetic consensus**. Provenance is pinned and recorded, but **model output is not
bit-for-bit deterministic** — determinism is claimed only for inventory, targeting,
chunking, fingerprints, scoring and report assembly. *(Resolves blocker 2's model side.)*

## 6. Governance — baseline, waivers, ownership, SARIF, gate

- **Baseline** (`.council/audit-baseline.json`) of accepted debt → re-runs surface only
  **NEW** issues. **Waivers** (`.council/audit-waivers.json`) with **expiry**; **P0
  non-waivable** by default; escalation/expiry counts as new; suppressions surfaced in
  SARIF; policy-file changes are themselves mandatory governance review.
- **Stable fingerprint** *before* baselines/gates: **versioned semantic identity**
  (not the drift-prone title-token/line-bucket ledger key), with legacy aliases +
  dual-read + a migration report; never infer `fixed` from mere absence in a
  differently-scoped run. *(Resolves blocker 5.)*
- **Ownership** via `CODEOWNERS`/git-blame → route findings to the right team.
- **SARIF 2.1.0** output (`--sarif`) for GitHub code scanning / dashboards / SIEM;
  human report + `docs/AUDIT.md` stay primary.
- **PR gate** exits `pass` / `fail` / **`indeterminate`** (fail on new P0/P1; indeterminate
  when required coverage/verification is missing).

## 7. External detectors — safe, opt-in

Policy-declared **argv arrays (never shell strings)** through the existing process
layer, with executable/version probes, cwd, timeout, output cap, accepted exit codes,
parser id, network policy, required/optional flag. Support `npm audit`, configured
coverage/test commands, existing linters — **installing nothing**. Failures /
unsupported platforms become explicit coverage/tool outcomes (→ `indeterminate` when a
*required* tool fails). All results normalize to **candidates** requiring reachability
verification before promotion.

## 8. `fix` consumption contract

`/council:audit fix` may consume **only** findings that are: current-snapshot,
`confirmed`, consensus-satisfied, `fixDisposition: localized`, non-protected target,
with evidence incl. a suitable **test gate**. It keeps every existing safety boundary
(clean-tree lock, isolated branch, one-writer-per-file, touched-file enforcement,
rollback, test gate) and **adds** a green pre-fix baseline, post-fix targeted/full
tests, and a **same-lens re-audit before marking `fixed`**. Everything protected /
cross-cutting stays propose-only regardless of score. *(Resolves blocker 1's fix side.)*

## 9. Phased build (each slice shippable + tested)

- **Phase 0 — contracts.** Schemas, fixtures, lifecycle invariants, semantic
  fingerprints, backward-compatible normalization. *No behavior change.*
- **Phase 1 — deterministic read-only foundation.** Broaden inventory, lens registry,
  mandatory-set discovery, evidence locations, targeting, risk calc, honest coverage.
- **Phase 2 — the minimum enterprise-credible core.** Self-driving `/council:audit`
  across all lenses, full mandatory-surface coverage, Codex+spawn-Claude routing,
  adversarial P0/P1 verification, consensus enforcement, provenance, baseline +
  expiring waivers, CODEOWNERS routing, SARIF, pass/fail/indeterminate gate. **No code
  writes.**
- **Phase 3 — `fix` adaptation.** Consume only confirmed schema records; keep every
  safety boundary; add pre/post test + same-lens re-audit.
- **Phase 4 — external adapters + scale.** Opt-in npm-audit/coverage/linter adapters,
  deterministic P2 QC sampling, hierarchical reduction for 3000+ files, richer
  standards profiles.
- **Phase 5 — trajectory.** Extend `metrics.jsonl` with per-lens risk totals,
  new/fixed/refuted counts, FP intervals, mandatory+tail coverage, waiver age, MTTR,
  risk burn-down — comparable only when policy/lens versions match.

Each phase ships with schema fixtures, malformed-output tests, Windows argv/path tests,
crash/resume tests, and golden SARIF/coverage reports.

## Top risks (council-surfaced)

- **False completeness** (a mandatory path missed) → union of globs + manifest + graph
  + sink discovery, deterministic reconciliation + critic, and a **fail-as-indeterminate**
  gate when required coverage is missing. *(P0)*
- **Agreement mistaken for proof** → evidence-derived confidence, adversarial verify,
  preserved `inconclusive`, reproducibility limited to deterministic stages. *(P1)*
- **Baseline/waiver gaming** → separate semantics, reviewable metadata + expiry, P0
  non-waivable, suppressions in SARIF, policy changes are mandatory review. *(P1)*
- **External-tool failure modes** → argv-only, no install, opt-in network, probes,
  bounded output/time, parser fixtures, required-failure → indeterminate. *(P1)*
- **Fingerprint migration loss** → versioned fingerprints, legacy aliases, dual-read,
  migration report, never infer `fixed` from absence. *(P2)*
- **First full audit is expensive** → exact-hash `(file,lens)` cache, closure-scoped
  invalidation, atomic checkpoints, bounded parallelism, honest-incomplete over
  weakened guarantee. *(P2)*

## Provenance

`/council:plan` job `council-8832cc0a`: Codex plan XL / confidence 0.92 (skeleton) +
Claude plan L / 0.7 (framing + phasing). Codex's five blockers on the Claude plan are
resolved above (§2 lens naming, §1/§8 finding schema + pipeline, §4 bounded coverage,
§3 verify semantics, §6 stable fingerprint). Grok unavailable — a 3-way re-run is worth
it before Phase 2.
