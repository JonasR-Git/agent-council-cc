---
description: Autonomously implement a PlanSpec on an isolated branch — test-first RED→GREEN per step, exact declared-file boundary, unanimous §6 council on the staged diff, rollback + abort on any failure, never merged
argument-hint: "--from <plan.json> [--dry-run] [--json]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

# Council build

Implements a validated PlanSpec (from `/council:plan`) one ordered step at a time on
an isolated `council/build-…` branch. Every step must earn its commit through a
fail-closed gate ladder; the FIRST gate failure rolls the step back and ABORTS the
whole run (steps are dependent). The base branch is never touched and nothing is ever
merged — you review the branch yourself.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/council-companion.mjs" build $ARGUMENTS
```

**Preflight (all-or-nothing):** a git repo on a named base branch, a **clean working
tree** (the rollback would destroy uncommitted work), `HEAD` identical to the plan's
`baseCommit`, a detectable test command, **every required §6 seat reachable** (the
built-ins plus every configured OpenRouter seat), and a GREEN baseline run of the
full suite. A repo-scoped lock forbids concurrent runs. Only then is the isolated
branch created off the clean base.

**Per step, in plan order:**

1. **Snapshot + budgets** — record git HEAD; bound attempts, wall-clock, diff bytes.
2. **Revalidate against the tree** — `create` paths must not exist, `edit` paths must
   be regular files, all paths safe + unprotected, impl and test sets disjoint, at
   least one test file.
3. **Test first** — a dedicated model call authors ONLY the step's declared test
   files. Model output is handled as DATA (the writer gets no file/shell/network
   tools). A static firewall admits only `node:test` + `node:assert` with a
   discriminating value-comparison assertion — no child_process/fs/net/eval/dynamic
   import. The test bytes are hashed and **immutable for the rest of the step**.
4. **RED before** — the test runs against the pre-implementation tree and must FAIL
   at assertion level (not a syntax/loader/crash/timeout error), deterministically.
   A tautological or always-green test is rejected here.
5. **Implementation** — a second model call authors ONLY the impl files. It cannot
   touch the hashed tests.
6. **Drift gate** — the actually-changed file set must EQUAL the step's declared
   `files[]`, exactly. The plan is a capability boundary, not a suggestion: one
   unexpected or missing path fails the step. Content protection runs before + after.
7. **GREEN after** — the byte-identical hashed test now passes, deterministically.
   The only difference vs RED is the implementation bytes.
8. **Full suite** — the project's whole test suite is green on the candidate.
9. **§6 council** — every required seat independently reviews the SAME complete
   staged multi-file diff + the step + the test + the RED/GREEN evidence
   (nonce-fenced as untrusted data). The verdict must be **unanimous**: a missing,
   dissenting, abstaining, unparseable, or timed-out vote VETOES. An oversized diff
   is a veto — a truncated diff is never reviewed; split the step in the plan.
10. **Reviewed-byte binding** — after the review, the changed set, the test hash, and
    the staged diff are re-checked **byte-for-byte** against what the council saw;
    only then is the already-staged index committed. One commit per step.
11. **Rollback** — any gate failure hard-resets to the step snapshot (verified clean)
    and aborts the run. A failed restore is reported as `stranded`: repair the
    working tree by hand before doing anything else.
12. **Final** — the full suite runs on the finished branch; the run returns to the
    base branch. The build branch is KEPT for human review and **never merged**.

Flags:

- `--from <plan.json>` (required) — the PlanSpec JSON from `council plan`. The file's
  `requestHash` must match its `request`, and its `baseCommit` must equal the current
  `HEAD` — after the base moves, re-plan; a stale plan is refused.
- `--dry-run` — validate the plan, run preflight, and print the per-step plan (files,
  tests, order) without writing anything.
- `--json` — the machine-readable build report (per-step gates/verdicts/commit or
  rollback, final integration, `returnedToBase`, `stranded`).

**Deliberate non-features (no escape hatches):** no `--allow-untested`, no
`--skip-council` or reduced council, no dirty-tree mode, no arbitrary shell test
command, no auto-resume, no auto-merge. If a gate blocks you, fix the plan or the
repo — not the gate.

Scope is deliberately narrow in v1 — pure Node ESM library steps (create/edit `.mjs`
source + `node:test` tests); see the LIMITATIONS section of
`docs/plan-build-usage.md`. Present the build report; on success point the user at
the branch (`git log --oneline <base>..<branch>`) and at the usage doc for the
review-and-merge steps.
