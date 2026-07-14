---
description: Autonomous review → fix → re-review loop (the WRITE verb) — fixes findings on an isolated, test-gated branch; propose-only by default, never auto-merged
argument-hint: "[focus] [--no-loop] [--dry-run] [--from <json>] [--resume] [--min-severity P0|P1|P2] [--max-fixes <n>] [--max-passes <n>] [--deep] [--supervise] [--flat] [--autonomy <lvl>] [--usage-ceiling [pct]] [--pause-at-5h off|<pct>|auto[:<pct>]] [--structure-auto-apply] [--sensitive-auto-apply] [--acknowledge-consents] [--html] [--retry-on-limit]"
disable-model-invocation: true
allowed-tools: Bash(node:*), Bash(git:*)
---

# Council fix — the write verb

**`/council:fix` is the ONE writing verb.** `/council:review` (and every read-only
sweep — `deep`/`endless`/`run`) stops at a decision table; `/council:fix` is what
actually edits code: the autonomous **review → fix → re-review** loop, run to
convergence (fix-until-dry) on an **isolated branch**, **test-gated**, and **never
auto-merged**.

Run it — bare `fix` reads the `fix:` block in `.council.yml` for its run-behavior
defaults (loop/deep/autonomy/max_passes/usage_ceiling/…), so a plain invocation runs
your configured autonomous profile. Flags are **override-only** (an explicit flag >
`fix.<key>` > built-in default):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/council-companion.mjs" fix $ARGUMENTS
```

`$ARGUMENTS` = optional focus text + override flags. Present the companion's report,
then a short Claude synthesis (what was fixed / what was left as a proposal and why),
and point the user at the branch to review.

## Key overrides

| Flag | Effect |
|------|--------|
| *(none)* | Config-driven autonomous loop from the `fix:` block; **propose-only** unless a consent channel is active (below). |
| `--no-loop` | Single pass — review → fix → re-review once, no fix-until-dry loop. |
| `--dry-run` | Preview the fix plan without touching any file (always wins; overrides every consent). |
| `--from <json>` | Take findings from a prior `review --json` (confined to the project root) instead of a fresh review. |
| `--resume` | Continue a checkpointed run instead of re-spending the budget. |
| `--min-severity P0\|P1\|P2` | Gate (default P2). `--max-fixes <n>` caps the number of fixes; `--max-passes <n>` / `--dry-streak <n>` bound the loop. |
| `--deep` | Max analysis depth — grouped six-eyes over the full lens partition + completeness critic + char-test gate. |
| `--supervise` | Wrap the loop in the endless supervisor so a multi-hour run survives rate-limit resets (reset-aware wait + resume). |
| `--flat` | One flat pass instead of the structure → correctness → quality tier gate. |
| `--usage-ceiling [pct]` / `--pause-at-5h off\|<pct>\|auto[:<pct>]` | Quota stops (weekly hard stop; the 5h soft pause is ON by default at 85%). |
| `--no-<flag>` | Turn a config-true default OFF for one run (e.g. `--no-deep`, `--no-structure-auto-apply`). |
| `--html` | Write a self-contained report; `--retry-on-limit` rides out rate limits. |

## Consent model — propose-only by default (Appendix D)

**Auto-apply is never sourced from tracked config.** A `fix.structure_auto_apply` /
`sensitive_auto_apply` in the committed `.council.yml` is **ignored and warned** (it
would spread WRITE consent to every clone/fork/PR-checkout). With no active consent
channel and no explicit flag, `fix` is **propose-only** — it plans fixes but applies
nothing. Enable auto-apply ONLY via one of:

1. **Explicit flag, per-invocation (no persistence):** `--structure-auto-apply`
   and/or `--sensitive-auto-apply` on this one command.
2. **Out-of-tree trust file:** a **gitignored** `.council.local.yml` in the repo root
   carrying the consents + a `trust_fingerprint` that matches this repo's git origin,
   then `/council:fix --acknowledge-consents` **once per clone** to record the ack in
   the plugin state dir.
3. **Env + ack:** `COUNCIL_TRUST_FIX=1` plus that same one-time per-clone ack.

A fresh clone (no `.council.local.yml`, no ack) can never silently auto-apply. The
effective-consent banner prints its source (+ `(acknowledged)`) to stderr on every
run, **even under `--json`**; `--dry-run` and `--no-<consent>` always win.

## Safety envelope

Writes land ONLY on an isolated `council/audit-fix-<sha>` branch, one writer per file,
each kept fix its own single-file commit; a fix is reverted if it strays outside its
target file or turns the test suite red (the test gate is mandatory — there is no CLI
bypass). Cross-cutting / SSOT findings and protected paths (`.git`, `node_modules`,
build output, `.env`/secrets/CI/Dockerfile, lockfiles) are never auto-patched. A clean
working tree is required and a repo-scoped lock forbids concurrent runs. **The base
branch is untouched — nothing is auto-merged; you review the branch.** See
`docs/audit-design.md` and `docs/cli-surface-design.md` for the rationale.
