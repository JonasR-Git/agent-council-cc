---
description: Multi-model design deliberation — every active seat proposes, all-to-all peer critique, one synthesizer emits a validated PlanSpec artifact (strictly read-only)
argument-hint: "[--json] [--synthesizer <seat>] [--codex-model <id>] [--grok-model <id>] [--codex-effort <l>] [--grok-effort <l>] [--skip-codex|--skip-grok|--skip-claude|--skip-openrouter] [--timeout <s>] [--background] [feature request]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

# Council plan

Design a feature with the full council BEFORE any code is written:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/council-companion.mjs" plan $ARGUMENTS
```

Three rounds over **every active seat** (the built-ins codex/grok/claude plus every
configured OpenRouter seat — the dynamic seat registry, never a fixed pair):

- **R1 — independent proposals.** Every active seat designs the feature on its own,
  firewalled: no seat sees another seat's proposal before writing its own.
- **R2 — all-to-all peer critique.** Every seat critiques and scores the merged
  proposal set; the proposals are ranked.
- **R3 — synthesis.** One synthesizer seat (default `claude`; override with
  `--synthesizer <seat>`) merges the ranked material into ONE **PlanSpec**: ordered,
  dependency-acyclic build steps, each with an explicit file list (`create|edit`
  action, `source|test` role), a per-step test intent, plus a risk register.

The PlanSpec is **validated fail-closed** before anything is written: strict JSON, no
unknown keys, bounded sizes, unique + acyclic step ids, at least one step, non-empty
file lists, repo-relative POSIX paths only (no traversal/absolute/drive paths), and
protected paths rejected (CI, git internals, dependencies, lockfiles, secrets,
council state). A test path is allowed only where the step itself declares it with
`role: "test"`. An invalid synthesis is retried once with the validation errors
attached; if it is still invalid the run FAILS — no partial artifact is ever emitted.

Output: a PlanSpec **markdown** (for you to read) + **JSON** (the input for
`council build --from`), both saved under the council state dir — the run prints the
exact paths. The JSON records `requestHash` + `baseCommit`; `council build` refuses a
plan whose base commit no longer matches the repo.

- **Strictly READ-ONLY**: no repo writes, no branch, no writer. The only writes are
  the two artifacts in the state dir (outside the repo).
- `--json` emits the machine report; `--background` + `/council:status` for long
  deliberations; the usual per-seat model/effort flags and `--timeout <s>` apply.
- Skip flags (`--skip-codex` `--skip-grok` `--skip-claude` `--skip-openrouter`)
  narrow the deliberation — acceptable here because plan is read-only. The §6 review
  gate inside `council build` has **no** skip flags.

A PlanSpec is a model artifact: validation proves its shape and path safety, NOT that
the design is right. **Read it — and edit it if needed — before `council build`**
(see `docs/plan-build-usage.md` for the end-to-end workflow).

Present the PlanSpec markdown to the user, flag anything you disagree with, and offer
`/council:build` as the next step. For the interactive 3-agent solve protocol (plan +
one supervised writer inside this session), use `/council:solve` instead.
