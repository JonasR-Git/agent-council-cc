# Council for Claude Code

A Claude Code plugin that reviews your code with a **multi-agent council** —
Claude + Codex + Grok each review independently, then critique each other and
reach consensus. You get fewer false positives, explicit disagreement, and a
clear "fix now / verify / ignore" decision instead of one model's opinion.

## What it does

Six slash commands:

| Command | Purpose |
|---------|---------|
| `/council:review` | Code review — 3-way deliberate (default), `--quick` dual, `--adversarial`, or `--loop` (review→fix→re-review) |
| `/council:plan` | Design an approach: independent plans → scored critique → ranked synthesis (no code) |
| `/council:solve` | Plan + one writer implements on a branch + council review |
| `/council:status` | Job control: list/status, `--watch` (live dashboard), `--result` (`--summary`/`--html`), `--wait`, `--cancel` |
| `/council:setup` | Check backends + scaffold `.council.yml` (`--init`) + `--usage` (limits/tokens) |
| `/council:doctor` | End-to-end self-test (CLIs, state dir, limits, live agent pings) |

Power-user analytics (`metrics`, `history`, `ledger`, `overview`, `benchmark`,
`worktree`) stay available as `node scripts/council-companion.mjs <subcommand>`.

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

`/council:doctor` verifies all of this end-to-end; `/council:setup` prints the
exact next step for anything missing.

## Install

From Claude Code:

```text
/plugin marketplace add /path/to/agent-council-cc
/plugin install council@agent-council
/reload-plugins
```

On Windows the marketplace path may use forward slashes, e.g.
`C:/path/to/agent-council-cc`. Once published to a Git host, users add it with
`/plugin marketplace add <owner>/<repo>` instead of a local path.

Smoke test without installing:

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

## Live dashboard

```text
/council:review --background
/council:status --watch            # most recent job
```

`watch` shows per-agent Round 1 state, R1/R2 progress bars, elapsed + remaining
estimate, and (on completion) a findings breakdown (raised / shared / disputed,
severity histogram, must-fix count). In a real terminal it redraws live and is
ANSI-colored; in the chat it prints a single snapshot (`--once`/`--json`). Tip:
run it in a separate terminal pane for the smooth live view.

## Typical flows

```text
/council:review --background
/council:status
/council:status --result

/council:review --adversarial --background look for race conditions and soft-delete mistakes
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
