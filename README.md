# Council for Claude Code

A Claude Code plugin that reviews your code with a **multi-agent council** —
Claude + Codex + Grok each review independently, then critique each other and
reach consensus. You get fewer false positives, explicit disagreement, and a
clear "fix now / verify / ignore" decision instead of one model's opinion.

## What it does

**Seven verbs.** Every capability is one of these — a read-only side and a single write verb
(`fix`) clearly separated:

| Command | Purpose | Writes? |
|---------|---------|---------|
| `/council:review` | Multi-model review — `--mode quick\|deliberate\|adversarial\|deep\|endless\|run` (diff review or whole-project audit) | **never** |
| `/council:fix` | The one write verb: autonomous, test-gated review → fix → re-review loop on an **isolated branch** (nothing auto-merged) | isolated branch |
| `/council:plan` | Multi-model design deliberation → a validated **PlanSpec** (every seat proposes, every seat peer-critiques, one synthesizes) | plan artifact only |
| `/council:build` | Autonomously implement a PlanSpec on an isolated branch, step by step, each test-gated + council-gated + rolled back on failure | isolated branch |
| `/council:solve` | Plan + exactly one writer implements on a branch + council review | branch |
| `/council:status` | Job control: `--watch` (live dashboard, `--md` for chat), `--result` (`--summary`/`--html`), `--wait`, `--cancel`, plus `--history`/`--metrics`/`--usage`/`--ledger`/`--overview` analytics | never |
| `/council:setup` | Check backends + `--check` self-test + scaffold `.council.yml` (`--init`) + `--usage` (limits/tokens) | `.council.yml` on `--init` |

`review --mode deep\|endless\|run` is the **whole-project audit** (was `/council:audit`; see below).
`setup --check` is the end-to-end self-test (was `/council:doctor`). Hidden internals
(`worker`, `worktree`, `benchmark`) run as `node scripts/council-companion.mjs <verb>`.

> Add `--explain` to any verb for a read-only dump of every effective knob and where it came from
> (flag / config / consent / built-in) — nothing runs, nothing is written.

### What `council build` actually guarantees

Every step passes a fail-closed ladder before a single byte is committed:
**preflight** (clean tree, `HEAD` == the plan's base, a real test command, every §6 seat
reachable, a green baseline — a miss refuses to start and spends nothing) → **test-first
RED**: the authored test must fail at *assertion* level before the implementation exists (a
syntax error or crash is **not** a valid RED, so a tautological test cannot slip through) →
**implementation** (the model returns file contents as *data*; it gets no fs/shell tools) →
**drift**: the changed set must equal the step's declared files *exactly* → **GREEN**: the
same, byte-hashed test now passes → **full suite** → **unanimous §6 council** on the complete
staged diff → **reviewed-byte binding** (what is committed is byte-for-byte what the council
saw). Any failure reverts the step and **aborts the run** — later steps depend on earlier ones.
There are **no escape hatches**: `--allow-untested`, `--skip-council`, `--allow-dirty` and
`--force` do not exist, and the 8-step blast-radius bound can only be *tightened*, never raised.

**Honest limits.** Autonomous builds are for **pure Node ESM library steps**. Dependency,
CI/config, migration, secret and auth/crypto paths are protected — a plan declaring one is
rejected. Under the test sandbox (which is what stops a prompt-injected test from shelling
out) Node's permission model blocks the V8 inspector, so *changed-line coverage cannot be
measured*; the gate degrades to a poison-probe dependence check and **says so** rather than
claiming coverage it did not take. Review the branch yourself — nothing is ever merged for you.

Highlights: verification-first (adversarially refute P0/P1 before surfacing),
model-agnostic consensus + a findings ledger that recognizes issues across runs,
a **separated Claude reviewer backend** (`claude_backend: spawn` runs an
independent read-only `claude -p` so the orchestrating session can judge
neutrally), configurable `reviewers`, budget guardrails, prompt-injection
hardening, and cross-platform (Windows/macOS/Linux) with zero runtime deps.

## Requirements

- Node.js >= 18.18
- Claude Code with plugin support

Reviewer backends (you only need the ones in your `reviewers` — check with
`which <tool>` first, don't reinstall if present):

| Backend | Install | Login | Notes |
|---------|---------|-------|-------|
| **Codex** | `npm i -g @openai/codex` (or `/plugin install codex@openai-codex`) | `codex login` | npm global |
| **Grok** | `curl -fsSL https://x.ai/cli/install.sh \| bash` | `grok login` | standalone binary at `~/.grok/bin/grok`; if present but not on PATH, set `GROK_BIN`; needs a SuperGrok/X Premium+ plan; run the installer in a real terminal (headless curls to the URL bot-block) |
| **Claude** (spawn backend only) | `npm i -g @anthropic-ai/claude-code` | run `claude` once | not needed for the default `session` backend |

`/council:setup --check` verifies all of this end-to-end; `/council:setup` prints
the exact next step for anything missing.

## Install

From Claude Code, in any project you want to review:

```text
/plugin marketplace add JonasR-Git/agent-council-cc
/plugin install council@agent-council
/reload-plugins
```

Then check your backends and log in to whatever is missing:

```text
/council:setup
```

(For local development on the plugin itself, add the checkout by path instead —
`/plugin marketplace add C:/path/to/agent-council-cc`.) Smoke test without
installing:

```bash
node plugins/council/scripts/council-companion.mjs setup --json
```

## Configure

Scaffold a project policy file (safe defaults + your overrides):

```text
/council:setup --init --reviewers claude,codex,grok --claude-backend session
```

`reviewers` picks who participates. `claude_backend` is `session` (Claude's R1
comes from the orchestrating session) or `spawn` (an independent
`claude -p --model <id>`, decoupled so the session judges neutrally). Logins are
per-CLI: `codex login`, `grok login`, and (for the spawn backend) run `claude`
once.

## Commands & flags

Every command is a slash command (`/council:<cmd>`) that shells out to the same
`council-companion.mjs`. Add `--json` to any command for machine-readable output.
Per-seat model/effort flags apply everywhere agents run: `--codex-model` /
`--grok-model` / `--claude-model`, `--codex-effort` / `--grok-effort`, and
`--skip-codex` / `--skip-grok` / `--skip-claude`.

### `/council:review` — read-only multi-model review

Default is a 3-way deliberation (Claude + Codex + Grok: independent, then peer critique). The
**`--mode`** selector is the single entry point for both diff review and the whole-project audit:

| `--mode` | What it does |
|----------|--------------|
| `deliberate` (default) | 3-way, independent → peer critique + consensus (diff) |
| `quick` | dual Codex+Grok, no peer round (you synthesize) |
| `adversarial` | challenge the design/direction |
| `deep` | whole-project **audit**: grouped six-eyes review of hotspot modules → `docs/AUDIT.md` proposals |
| `endless` | bounded whole-project review/propose loop (advances hotspots until returns diminish) |
| `run` | self-driving audit report + risk register + gate |

| Flag | Effect |
|------|--------|
| `--base <ref>` | review the diff vs a git ref instead of the working tree |
| `--reviewers claude,codex,grok` | choose who participates |
| `--claude-backend session\|spawn` | run Claude in-session, or as a decoupled spawned CLI |
| `--verify` | add a refutation pass (deliberate only) |
| `--format html` / `--doc` / `--sarif` | write a self-contained HTML report / `docs/AUDIT.md` / SARIF 2.1.0 (deep/run) |
| `--background` / `--wait` | run detached (monitor via `/council:status`) or block synchronously |

### `/council:fix` — the one write verb (autonomous, test-gated)

`fix` is the review → fix → re-review loop: it reviews, applies the **safe** fixes on an isolated
`council/audit-fix-<sha>` branch, re-reviews, and repeats until it converges — **nothing is
auto-merged**, `main` is never touched, you review the branch. A bare `fix` reads its whole profile
from the `fix:` block in `.council.yml`, so no long flag list is needed. Every flag is override-only
(precedence: flag > `fix.<key>` > built-in); turn a config-true off with `--no-<flag>`.

| Flag | Effect |
|------|--------|
| `--loop` | keep looping review → fix → re-review until convergence (vs a single pass) |
| `--deep` / `--groups fine\|tier\|lens` | grouped, cell-granular six-eyes review |
| `--epoch-sweep` | provable per-tier **100% cell coverage** via a durable run-wide ledger; a budget/pass ceiling stops with an explicit COVERAGE-INCOMPLETE debt that a same-epoch `--resume` continues |
| `--supervise` | survive rate-limit resets across a multi-hour run |
| `--usage-ceiling c/x/g` | stop between passes on a confirmed **weekly** per-model quota % (e.g. `90/90/90`) |
| `--pause-at-5h off\|<pct>\|auto[:<pct>]` | **5h** soft pause (default ON at 85%); `auto` waits in-process to the reset then self-resumes |
| `--autonomy <lvl>` | commit/propose dial |
| `--min-severity P0\|P1\|P2` / `--max-fixes <n>` | severity gate + fix cap |
| `--max-passes <n>` / `--dry-streak <n>` / `--budget <n>` / `--max-cells <n>` | loop bounds |
| `--from <json>` | reuse findings from a prior `review --json` (skip a fresh review) |
| `--dry-run` | preview the fix plan without editing (always wins over any consent) |

**What actually auto-applies.** A finding is auto-patched only if it is **localized** (single-file,
bounded), its changed lines are executed by a test, the **full suite stays green**, the public API is
unchanged, and — for a **sensitive** class (auth/crypto/concurrency/data/security) or a **structural**
transform — a **unanimous §6 Claude+Codex+Grok review of the exact staged patch** passes. Everything
else surfaces as a **proposal** in `docs/AUDIT.md`: cross-cutting / SSOT / architecture findings are
documented migrations, deliberately never blindly auto-patched. On a mature codebase most of the value
is therefore in the proposals, not auto-patches.

**Consent containment (autonomous auto-apply).** Sensitive/structural auto-apply needs an explicit,
**contained** consent — never the tracked `.council.yml` (a consent there would spread to every
clone/fork/PR-checkout and let a bare `fix` write with no consent from that operator). Put consents in
a **gitignored `.council.local.yml`**:

```yaml
fix:
  sensitive_auto_apply: true     # §6-gated sensitive fixes may auto-apply
  structure_auto_apply: true     # multi-file structural transforms may auto-apply (via the strict M9 ladder)
trust_fingerprint: <hash>        # must match this repo's git origin (a mismatch refuses)
```

then run `/council:fix --acknowledge-consents` **once per clone** (the ack is stored in the state dir,
bound to the origin fingerprint + workspace). A git-tracked `.council.local.yml` is **refused**; env
`COUNCIL_TRUST_FIX` is the alternative channel. Without consent, sensitive/structural findings stay
propose-only. `--dry-run` and `--no-<consent>` always win.

### `/council:plan` — converge a build spec across seats

| Flag | Effect |
|------|--------|
| `--synthesizer <seat>` | who synthesizes the converged PlanSpec |
| `--skip-openrouter` | drop OpenRouter seats | 
| `--background` / `--json` | run detached / machine output |
| `<feature request>` | positional: what you want built |

### `/council:build` — execute a PlanSpec (test-gated, isolated branch)

| Flag | Effect |
|------|--------|
| `--from <plan.json>` | the PlanSpec to build (**required**) |
| `--dry-run` | preview the build plan without writing |
| `--base <ref>` / `--json` | base ref / machine output |

Build runs a safety machine: preflight baseline suite → isolated branch → per-step
test gate → rollback on failure → never auto-merged. See the guarantees above.

### `/council:solve` — collaborative problem solving

| Flag | Effect |
|------|--------|
| `--debate-rounds 0\|1\|2` | peer-debate depth |
| `--debate-resume` | resume a checkpointed debate |
| `--background` / `--wait` | run detached / block |
| `<problem text>` | positional: the problem to solve |

### `/council:setup` — environment

| Command / flag | Effect |
|------|--------|
| `/council:setup` | report backends + suggested next step |
| `/council:setup --check` | end-to-end self-test — node + CLIs + state dir + live reachability ping (was `/council:doctor`) |
| `/council:setup --init [--reviewers … --claude-backend … --force]` | write a `.council.yml` |
| `/council:setup --usage [--days <n>]` | per-seat quota usage (weekly + 5h) |

### `/council:status` — monitor background jobs

| Flag | Effect |
|------|--------|
| `[job-id]` | default: the most recent job |
| `--watch` | live auto-refreshing dashboard |
| `--result [--summary\|--html]` | final report (trimmed / self-contained HTML) |
| `--wait [--follow]` | block until the job finishes |
| `--cancel` | cancel a running job |

## Deliberate protocol

Round 1 is independent: Claude writes its own JSON findings first, while Codex
and Grok produce structured findings in parallel. Round 2 asks agents to
critique each other's findings and vote `agree`/`disagree`/`uncertain`, then the
report merges consensus vs unique with peer votes.

Write Claude's R1 JSON to an OS temp path **outside the repo** — untracked file
bodies are included in review context, so a repo-local scratch file would
contaminate Codex/Grok input.

```text
# POSIX
/council:review --claude-findings /tmp/council-claude-r1.json

# Windows
/council:review --claude-findings C:\Users\you\AppData\Local\Temp\council-claude-r1.json
```

With `--claude-backend spawn` you skip that step — the spawned Claude produces
R1 itself. Parallel mode starts the agents first, then waits for Claude's file:

```text
/council:review --claude-findings-wait /tmp/council-claude-r1.json --wait-timeout 600 --background
```

R2 cost is bounded: only `peer_critique_severities` (default `P0,P1`) are
critiqued, critics see per-finding code evidence instead of the full diff, and
Grok critiques run at `r2_effort`.

## Solve protocol

`/council:solve` turns the council into a problem-solving panel: every agent
writes an independent plan, then scores the others (feasibility/risk/simplicity/
completeness, overall 1-10). The report ranks the plans; Claude synthesizes the
final one, gets approval, and exactly ONE writer (`solve_writer`) implements it
on a branch. `/council:review` then reviews the diff — the writer's own
verdict does not count towards approval.

```text
/council:solve --background how should we add offline support to the sync engine?
```

Optional bounded debate (never a live chat): `--debate-rounds 1` gives each
disputed item's author one rebuttal; `--debate-rounds 2` adds one counter by the
original critic. Hard caps: 6 items, 2 rounds.

## Whole-project audit

The whole-project audit reviews the **entire project** (not a diff), in layers you can run
independently — all under `review --mode …` (read-only) and the one write verb `fix`:

```text
/council:review --mode run                 # self-driving report + risk register + gate (read-only)
/council:review --mode deep --doc          # deep agent review of the top hotspots -> proposals in docs/AUDIT.md
/council:review --mode endless             # bounded review loop: advances hotspots until returns diminish
/council:fix --dry-run                     # preview the safe auto-fix plan; drop --dry-run to apply
```

The engine is **static analysis as the precision layer, agents as the judgment**:
a zero-dep import/export graph, line-level duplicate detection, complexity, git
churn, smells and test-mapping produce a hotspot-ranked, confidence-tagged
candidate list; `review`/`endless` then send the actual source of the top hotspots
to Codex/Grok. Every static fact is a **candidate, never authority** — nothing is
deleted or merged from a regex alone.

`fix` is the only verb that writes code, and only under hard safety rules: **localized** findings
only by default (cross-cutting stay proposals unless `structure_auto_apply` is consented), one writer
per file on an isolated `council/audit-fix-<sha>` branch, each fix must touch **only** its target file
and keep the project's tests **green** (else it is reverted), each kept fix is its own commit, the base
branch is never modified and nothing is auto-merged. It requires a **clean working tree** and a **test
gate** (see the per-project note below). `review --mode endless` is a review/propose loop — it never
auto-fixes. Findings persist to the cross-run **ledger**, so a later run recognizes what was already
flagged and `fix` marks what it fixed as resolved.

Design rationale and phasing: [docs/audit-design.md](docs/audit-design.md).

## Trying it on your project

Works on **any language / any git repo**: `/council:review` (diff — 3-way deliberate by default,
selector `--mode quick|deliberate|adversarial`) and the agent-based `review --mode deep|endless`
(the agents read your real source, so language doesn't matter).

Two things are currently **JS/npm-tuned** — know this before you rely on them:

- **`review --mode run` static analysis** — the import-graph / orphan / cycle layer is
  ESM/JS-specific. On JS/TS you get the full signal; on other languages you still
  get duplication, churn, complexity, smells and the file map, but no import graph.
  The agent review works regardless.
- **`fix` test gate** — it auto-detects the project's **`npm test`** script (e.g. `vitest run`).
  No `package.json` test script → it refuses (rather than commit unverified edits); the test gate
  is mandatory with no CLI bypass. So the safe fix path is npm-projects-with-tests only for now.

Recommended first run, read-only → writing:

```text
/council:setup                       # 1. which backends are available?
/council:review --mode run           # 2. static overview (read-only)
/council:review --background         # 3. review a branch with changes
/council:review --mode deep --doc    # 4. deep review + proposals doc
/council:fix --dry-run               # 5. only on an npm project with tests, preview first
```

If a backend is down (e.g. Grok), runs degrade gracefully to whoever is available
(`--skip-grok` / `--skip-codex`, or just let `/council:setup` show what's missing).
State is stored **per workspace** and the plugin is zero-dependency and
self-contained, so it can't contaminate the project you point it at.

## Live dashboard

```text
/council:review --background
/council:status --watch            # most recent job
/council:status --watch --md       # rich Markdown snapshot for the chat
```

`watch` shows per-agent Round 1 state, R1/R2 progress bars, elapsed + remaining
estimate, and (on completion) a findings breakdown. In a real terminal it redraws
live and is ANSI-colored; run it in a separate terminal pane for the smooth live
view.

Add **`--md`** for a chat-optimized Markdown snapshot (a real table with emoji
status, Unicode bars, severity squares, live per-agent `raised`, and a "Δ since
last update" line). When the run finishes it becomes a decision aid: each
reviewer's **verdict**, the **top must-fix** findings with `file:line`, the
cross-run **ledger split** (recurring vs new), verify hold-up, and the
localized-vs-cross-cutting action split.

## Typical flows

```text
/council:review --background
/council:status
/council:status --result

/council:review --mode adversarial --background look for race conditions and soft-delete mistakes
```

## State and environment

Job state is stored per workspace under
`~/.claude/agent-council-state/council/<workspace-slug-hash>/`.

| Variable | Meaning |
|----------|---------|
| `AGENT_COUNCIL_STATE_DIR` | Council state root |
| `GROK_BIN` / `GROK_PATH` | Path to the `grok` binary |
| `GROK_COMPANION_PATH` | Path to a separately-installed `grok-companion.mjs` (optional) |
| `CODEX_COMPANION_PATH` | Path to `codex-companion.mjs` |
| `CLAUDE_BIN` / `CLAUDE_PATH` | Path to the `claude` binary (spawn backend) |

## Policy

`/council:setup --init` scaffolds `.council.yml`; `.council.example.yml`
documents every key. Common ones:

```yaml
reviewers: [claude, codex, grok]
claude_backend: session      # session | spawn
scope: auto
agent_timeout_minutes: 30
require_consensus_for: [auth, concurrency, data-loss, compliance, security]
peer_critique_severities: [P0, P1]
r2_effort: medium
verify_findings: false
budget_guard: 0
solve_writer: claude
```

`skip_paths` applies to git status/diff pathspecs and untracked-file inclusion
in deliberate/solve context (the cheaper `review`/`adversarial` paths delegate
context to the companions and do not apply it). Codex reasoning effort comes
from `~/.codex/config.toml`; the `codex_effort` key / `--codex-effort` flag are
accepted for compatibility but ignored.

## Model configuration

Prefer per-agent flags (or the matching `.council.yml` keys):

```text
/council:review --codex-model gpt-5.5 --grok-model grok-4.5 --claude-model claude-opus-4-8
```

Grok effort: `--grok-effort`. Codex effort: configure in Codex itself.

## Development

```bash
npm test      # node:test, no npm dependencies
npm run lint
```

Release history: [CHANGELOG.md](CHANGELOG.md).

## License

MIT (this toolkit). The Codex plugin remains Apache-2.0 (OpenAI); the Grok CLI
is covered by xAI terms.
