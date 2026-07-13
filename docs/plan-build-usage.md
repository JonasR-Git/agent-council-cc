# `council plan` → `council build` — the end-to-end workflow

Two commands over one shared artifact, the **PlanSpec**. `plan` designs (read-only,
multi-model), `build` implements (isolated branch, fail-closed gates) — and **you**
review and merge. Neither command ever merges anything. Design rationale:
`docs/plan-build-design.md`; per-command reference: `plugins/council/commands/plan.md`
and `build.md`.

## 1. Plan

```bash
node plugins/council/scripts/council-companion.mjs plan "add a rate limiter to the fetch queue"
```

Every active seat (codex, grok, claude, plus every configured OpenRouter seat)
proposes independently, every seat peer-critiques the merged proposal set, and one
synthesizer (default `claude`, `--synthesizer <seat>` to override) merges the ranked
material into a single schema-validated PlanSpec. The run writes two artifacts under
the council state dir (`~/.claude/agent-council-state/council/<workspace>/…`, or
`$AGENT_COUNCIL_STATE_DIR`) and prints their paths:

- a `.md` file — the plan for you to read;
- a `.json` file — the machine PlanSpec that `build --from` consumes.

`plan` is strictly read-only: no repo writes, no branch, no writer.

## 2. Read — and edit — the PlanSpec

The most important step, and the one only you can do. Validation proves the plan's
*shape and path safety*, not that the *design* is right — seats can converge on a
wrong approach. Check, in the JSON:

- **Step order + `dependsOn`** — is the decomposition sensible? Steps run strictly in
  order and the run aborts at the first failure, so put the risky step early.
- **Each step's `files[]`** — this is a hard capability boundary: the writer may
  touch exactly this set and the commit is bound to exactly this set. Too broad =
  risk; a missing file = a guaranteed drift-gate failure.
- **Each step's `test.intent`** — the behaviour the model-authored test must prove.
  Vague intent produces a weak gate.
- **`risks`** — anything unmitigated you would not accept.

You may edit the JSON directly: reorder steps (respecting `dependsOn`), drop steps,
tighten file sets, sharpen intents. Constraints: it must stay schema-valid (`build`
revalidates everything fail-closed), leave `request`/`requestHash` untouched (they
must hash-match), and `baseCommit` must still be the commit you build from.

## 3. Build

```bash
node plugins/council/scripts/council-companion.mjs build --from <path/to/plan.json>
```

Preconditions (all enforced, none waivable): clean working tree, `HEAD` equal to the
plan's `baseCommit`, a detectable test command, every required §6 seat reachable, a
green baseline test run. Then, per step on an isolated `council/build-…` branch:

test authored first (static firewall, bytes hashed + immutable) → **RED** on the
pre-impl tree (must fail at assertion level, deterministically) → impl authored
(cannot touch the tests) → drift gate (changed set == declared set, exactly) →
**GREEN** with the byte-identical test → full suite → **unanimous §6 council** on the
complete staged diff (any missing/dissenting/unparseable/timed-out seat vetoes) →
reviewed-byte binding → one commit. Any failure: hard rollback to the step snapshot
and the run aborts. `--dry-run` previews all of it without writing.

## 4. Review the branch

The branch is left for you; the run returns to the base branch.

```bash
git log --oneline <base>..council/build-<slug>   # one commit per completed step
git diff <base>..council/build-<slug>
npm test                                          # on the branch, yourself
```

Review the **tests** especially: they are model-authored and machine-gated (the
RED→GREEN harness proved they *discriminate*; the council read them) — but only you
can confirm they prove the behaviour you actually wanted.

## 5. Merge yourself

`build` never merges, fast-forwards, or opens PRs. When you are satisfied:

```bash
git merge --no-ff council/build-<slug>    # or rebase/cherry-pick, your call
git branch -d council/build-<slug>
```

## When a run aborts

The report names the step and the gate that failed. Completed steps remain as commits
on the branch; the failed step was rolled back. There is **no resume**: your options
are (a) merge the good prefix yourself, then re-plan the remainder against the new
base, or (b) discard the branch and re-plan — a re-run needs a plan whose
`baseCommit` matches `HEAD` again. `stranded: true` means the automatic rollback
itself failed — inspect and repair the worktree by hand before anything else.

## Limitations (v1 — read before relying on it)

Honest scope. `build` is autonomous only inside a narrow, hard-fenced envelope:

- **Pure Node ESM library steps only** — creating/editing `.mjs` source plus
  `node:test`/`node:assert` tests. No UI work, no other languages, no build tooling.
- **No deletes, renames, moves, symlinks, or binary files** — steps only `create` or
  `edit` regular text files.
- **No dependency / CI / config changes** — `package.json`, lockfiles, `.github`,
  Dockerfiles, git internals, `.env`/secrets, and council state are protected paths;
  a plan naming them fails validation.
- **No cross-cutting structural transforms** — each step touches exactly its declared
  files, so repo-wide renames/refactors do not fit the model. Plan those for a human.
- **Model-authored tests gate the impl** — the harness proves each test fails before
  and passes after the impl with a real assertion, and the council reviews it, but
  none of that proves the test captures your full intent. Review the tests (step 4).
- **Bounded** — few ordered steps, limited attempts per step, diff-size caps. A large
  feature needs several plan→build cycles, merged by you in between.
- **Determinism required** — RED and GREEN are each verified deterministically; a
  flaky test suite will abort runs.
- **No resume, one run at a time** — an aborted run keeps its branch but cannot be
  continued; a repo-scoped lock forbids concurrent runs.
- **Green ≠ done** — a completed build is a well-evidenced *candidate* (test-gated,
  unanimously reviewed), not a shipped feature. The human review in steps 4–5 is part
  of the design, not an optional extra.
