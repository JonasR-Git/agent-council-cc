---
description: Multi-agent code review (READ-ONLY) — 3-way deliberate (default), quick dual, adversarial, plus read-only whole-project deep/endless/run sweeps
argument-hint: "[--quick|--adversarial] [--wait|--background] [--base <ref>] [--reviewers claude,codex,grok] [--claude-backend session|spawn] [--claude-model <id>] [--codex-model <id>] [--grok-model <id>] [--verify] [focus text]"
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Write, Bash(node:*), Bash(git:*), AskUserQuestion
---

# Council review

**`/council:review` is READ-ONLY — it never writes source or fixes.** To fix findings
autonomously, use **`/council:fix`** (the write verb). Reviews local git changes with
multiple agents. **Default mode is the full 3-way deliberate protocol** (independent
review → peer critique → consensus). Pick a lighter mode with a flag:

| Mode | When | What runs |
|------|------|-----------|
| *(default)* | before merge, risky changes | 3-way: Claude + Codex + Grok independent, then peer critique + consensus |
| `--quick` | fast dual check | Codex + Grok in parallel, no peer round; you synthesize |
| `--adversarial` | challenge design/direction | Codex + Grok adversarial pass + focus text |

Read-only whole-project sweeps are the same `review` verb under deeper `--mode`s —
all review/propose engines that never edit source:

| `--mode` | What runs | Key knobs |
|----------|-----------|-----------|
| `deep` | grouped six-eyes whole-project hotspot review (Codex + Grok + Claude), plus a global SSOT/architecture reduce | `--groups fine\|tier\|lens` `--max-cells <n>` `--completeness-critic` `--areas a,b` `--churn-days <n>` `--budget <n>` `--max-units <n>` `--doc` `--write-map` |
| `run` | self-driving audit → risk register + pass/fail gate as one schema-valid report | `--sarif [--sarif-path <p>]` `--base <ref>` `--doc` |
| `endless` | bounded review/propose loop — each pass advances the reviewed window until returns diminish; never edits code | `--supervise` `--max-passes <n>` `--dry-streak <n>` `--resume` `--groups …` `--max-cells <n>` `--usage-ceiling [pct]` `--pause-at-5h off\|<pct>\|auto[:<pct>]` |

Their only writes are the opt-in artifacts `--doc` (`docs/AUDIT.md`, proposals — cross-cutting/SSOT items
are documented migrations, deliberately NOT auto-patched) and `--write-map` (`docs/codebase-map.json`),
both confined to the project root. There is **no** write mode on this slash — the autonomous
review → fix → re-review loop is **`/council:fix`**. See `docs/audit-design.md` for the engine rationale.

The companion exposes a single canonical `review --mode quick|deliberate|adversarial|deep|endless|run`
selector; the bare `review` verb **is** that canonical entry point (`review` ≡ `review --mode quick`).
This skill keeps **deliberate** as its default and runs Phase A first — do not collapse it to a raw quick command.

The mode flags above are **mutually exclusive**: if the raw arguments contain more than one
(e.g. `--quick --adversarial`), or a flag that disagrees with an explicit `--mode`, treat it as a
conflict — do not silently pick one; ask the user which mode they meant.

Raw arguments: `$ARGUMENTS` (strip the single mode flag; the rest is focus text + review flags).

Rules: **review-only — this slash never writes source** (to fix findings
autonomously, hand off to `/council:fix`); prefer `--background` for
non-trivial diffs; use **separate** `--codex-model`/`--grok-model` (not one
`--model`); `--reviewers` / `--claude-backend` select who participates.

---

## Default — deliberate (3-way independent → peer critique)

### Phase A — YOU (Claude) review FIRST  *(session backend only)*

With the default `claude_backend: session`, write your own findings first, without
calling Codex/Grok. Save JSON to an OS temp path **outside the repo** (untracked
file bodies are included in review input, so a repo-local scratch file contaminates
Codex/Grok context):

```json
{"agent":"claude","summary":"...","verdict":"approve|approve_with_nits|request_changes|block",
 "findings":[{"id":"claude-1","severity":"P0|P1|P2|nit","category":"bug|security|concurrency|data-loss|auth|compliance|performance|design|test|dx|other","title":"short","detail":"what/why","file":"path/or/null","line":null,"confidence":0.7}]}
```

With `--claude-backend spawn`, **skip Phase A** — an independent `claude -p` produces R1.

### Phase B — Codex + Grok (R1 independent + R2 peer critique)

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/council-companion.mjs" review --mode deliberate --claude-findings "$TMPDIR/council-claude-r1.json" $ARGUMENTS
```

Parallel: start the companion first, then write the file when Phase A ends:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/council-companion.mjs" review --mode deliberate --claude-findings-wait "$TMPDIR/council-claude-r1.json" --wait-timeout 600 --background $ARGUMENTS
```

The companion runs Round 1 (Codex + Grok independent, parallel) and Round 2 (each
critiques the others + votes agree/disagree/uncertain), then merges consensus vs
unique with peer votes. Cost is bounded: only `peer_critique_severities` (default
P0,P1) are critiqued, at `r2_effort`. `--verify` adversarially refutes P0/P1 before
surfacing them.

### Phase C — YOU peer-evaluate and decide

After the report (or `/council:status --result`): vote on consensus items, scrutinize
unique findings (auth/concurrency/data-loss), and produce a **decision table**
(Fix now / Verify / Ignore with `file:line`). Do not implement fixes here.

---

## `--quick` — dual review (no peer round)

Codex + Grok review the same target in parallel; you synthesize afterward.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/council-companion.mjs" review [--background] $ARGUMENTS
```

## `--adversarial` — challenge review

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/council-companion.mjs" review --mode adversarial [--background] $ARGUMENTS
```

Then present the report + a short Claude synthesis (consensus, unique P0s).

## Fixing findings — use `/council:fix` (not this slash)

`/council:review` stops at a decision table; it does **not** edit code. To drive a
change to council approval autonomously (review → fix → re-review until it goes dry),
run the write verb:

```bash
/council:fix                 # bare: reads the fix: config, propose-only by default
/council:fix --dry-run       # preview the plan without touching files
```

`/council:fix` writes ONLY on an isolated branch, test-gated, and never auto-merges;
auto-apply needs an explicit out-of-tree consent (see `/council:fix` for the consent
model). A human fix-loop is `fix` then `review` as **separate** verbs — never a review
flag.
