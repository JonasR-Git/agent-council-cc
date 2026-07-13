---
description: Multi-agent code review — 3-way deliberate (default), quick dual, adversarial, or a bounded fix-loop
argument-hint: "[--quick|--adversarial|--loop] [--wait|--background] [--base <ref>] [--reviewers claude,codex,grok] [--claude-backend session|spawn] [--claude-model <id>] [--codex-model <id>] [--grok-model <id>] [--verify] [focus text]"
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Edit, Write, Bash(node:*), Bash(git:*), AskUserQuestion
---

# Council review

Reviews local git changes with multiple agents. **Default mode is the full 3-way
deliberate protocol** (independent review → peer critique → consensus). Pick a
lighter or looped mode with a flag:

| Mode | When | What runs |
|------|------|-----------|
| *(default)* | before merge, risky changes | 3-way: Claude + Codex + Grok independent, then peer critique + consensus |
| `--quick` | fast dual check | Codex + Grok in parallel, no peer round; you synthesize |
| `--adversarial` | challenge design/direction | Codex + Grok adversarial pass + focus text |
| `--loop` | drive to approval | review → fix → re-review until ≥2 approve (max 3 rounds; you are the writer) |

Under the hood the companion exposes a single canonical `review --mode quick|deliberate|adversarial`
selector. The bare `review` verb **is** that canonical entry point (`review` ≡ `review --mode quick`);
`deliberate` and `adversarial` are equivalent **legacy alias verbs** (`deliberate` ≡ `review --mode
deliberate`, `adversarial` ≡ `review --mode adversarial`). This skill keeps **deliberate** as its
default and runs Phase A first — do not collapse it to a raw quick command.

The mode flags above are **mutually exclusive**: if the raw arguments contain more than one
(e.g. `--quick --adversarial`), or a flag that disagrees with an explicit `--mode`, treat it as a
conflict — do not silently pick one; ask the user which mode they meant.

Raw arguments: `$ARGUMENTS` (strip the single mode flag; the rest is focus text + review flags).

Rules: review-only (except `--loop`, which fixes); prefer `--background` for
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
node "${CLAUDE_PLUGIN_ROOT}/scripts/council-companion.mjs" deliberate --claude-findings "$TMPDIR/council-claude-r1.json" $ARGUMENTS
```

Parallel: start the companion first, then write the file when Phase A ends:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/council-companion.mjs" deliberate --claude-findings-wait "$TMPDIR/council-claude-r1.json" --wait-timeout 600 --background $ARGUMENTS
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
node "${CLAUDE_PLUGIN_ROOT}/scripts/council-companion.mjs" adversarial [--background] $ARGUMENTS
```

Then present the report + a short Claude synthesis (consensus, unique P0s).

## `--loop` — review → fix → re-review (bounded)

Drive a change to council approval; **you are the writer and orchestrator**. Treat
`$ARGUMENTS` as focus text only (never pass loop knobs as companion flags).

1. Clean branch; record `BASE=$(git rev-parse HEAD)` **once** (keep it fixed).
2. Round 1..3:
   - Review the diff since BASE (deliberate, your R1 first):
     ```bash
     node "${CLAUDE_PLUGIN_ROOT}/scripts/council-companion.mjs" deliberate --base "$BASE" --claude-findings-wait "<ostemp>/fixloop-claude-r<round>.json" --wait-timeout 600 "<focus>"
     ```
   - Read the decision (never eyeball it):
     ```bash
     node "${CLAUDE_PLUGIN_ROOT}/scripts/council-companion.mjs" fixloop-status JOBID --writer claude --needed 2 --json
     ```
     `stop-approved` → stop (hand back for merge); `stop-escalate-to-human` or
     `incomplete:true` → stop, summarize, ask; `fix-and-rereview` → fix the
     `actionable` findings you agree with (verify each against the code), commit
     `fixloop round <n>: ...`, continue.
3. Stop at approval, escalation, or the 3-round cap. The writer never self-approves.
