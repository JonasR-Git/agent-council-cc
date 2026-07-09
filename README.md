# Agent Council for Claude Code

Claude Code plugins that wire **Grok Build** and a **multi-agent council** (Codex + Grok + Claude) into a local review workflow.

## Plugins

### `grok`

| Command | Purpose |
|---------|---------|
| `/grok:setup` | Check Grok CLI + auth |
| `/grok:review` | Read-only review of the working tree or `--base` diff |
| `/grok:adversarial-review` | Challenge-style review + focus text |
| `/grok:rescue` | Hand a task to Grok |
| `/grok:status` / `result` / `cancel` | Job control |

### `council`

| Command | Purpose |
|---------|---------|
| `/council:setup` | Probe Codex companion + Grok + policy file |
| `/council:deliberate` | 3-way independent review, then peer critique |
| `/council:solve` | 3-way problem solving: independent plans, scored critique, synthesis, one writer, council review |
| `/council:review` | Faster dual Codex + Grok review |
| `/council:adversarial` | Dual adversarial review |
| `/council:status` / `result` / `cancel` | Council job control (`result --summary` prints only the decision-relevant sections) |
| `/council:wait` | Block until a background job finishes (watchers get process-exit semantics) |
| `/council:usage` | Per-kind job stats + per-agent call/failure/timeout counts, with provider quota pointers |

## Requirements

- Node.js >= 18.18
- Claude Code with plugin support
- Codex plugin/CLI, recommended: `codex@openai-codex`
- Grok Build CLI from xAI with `grok login`

## Install (local marketplace)

From Claude Code:

```text
/plugin marketplace add /path/to/agent-council-cc
/plugin install grok@agent-council
/plugin install council@agent-council
/reload-plugins
```

On Windows, the marketplace path can use forward slashes, for example
`C:/path/to/agent-council-cc`.

## Use only the Grok plugin

The Grok plugin is fully supported as a standalone install. Install only
`grok@agent-council`; neither the Codex plugin nor the council plugin is required.

```text
/plugin install grok@agent-council
/reload-plugins
```

Run `grok login` before using it. The standalone commands are `/grok:setup`,
`/grok:review`, `/grok:adversarial-review`, `/grok:rescue`, `/grok:status`,
`/grok:result`, and `/grok:cancel`. The council plugin is an optional layer on
top when you want multi-agent deliberation.

Smoke test without installing:

```bash
node plugins/grok/scripts/grok-companion.mjs setup --json
node plugins/council/scripts/council-companion.mjs setup --json
```

## Deliberate Protocol

Round 1 is independent. Claude writes its own JSON findings first, while Codex and Grok produce structured findings through the companion. Round 2 asks agents to critique each other's findings and vote `agree`, `disagree`, or `uncertain`.

Write Claude's R1 JSON to an OS temp path outside the repo. Untracked file bodies are included in review context, so a repo-local scratch file would contaminate Codex/Grok input.

```text
# POSIX
/council:deliberate --claude-findings /tmp/council-claude-r1.json

# Windows
/council:deliberate --claude-findings C:\Users\you\AppData\Local\Temp\council-claude-r1.json
```

Parallel mode starts Codex/Grok first, then waits for Claude's file:

```text
/council:deliberate --claude-findings-wait /tmp/council-claude-r1.json --wait-timeout 600 --background
```

R2 critique cost is bounded: only findings in `peer_critique_severities` (default `P0,P1`) are critiqued, critics see per-finding code evidence snippets instead of the full diff, and Grok critiques run at `r2_effort` (default `medium`).

## Solve Protocol

`/council:solve` turns the council into a problem-solving panel: every agent writes an independent solution plan (`schemas/plan.schema.json`), then each scores the other plans (feasibility/risk/simplicity/completeness, overall 1-10) and lists blockers/improvements. The report ranks the plans; Claude synthesizes the final plan, gets user approval, and exactly ONE writer (`solve_writer` policy) implements it on a branch. `/council:deliberate` then reviews the diff — the writer's own verdict does not count towards approval.

```text
/council:solve --background how should we add offline support to the sync engine?
```

To include Claude's independent plan from a temp file, use either path style:

```text
# POSIX
/council:solve --claude-plan /tmp/council-claude-plan.json how should we add offline support?

# Windows
/council:solve --claude-plan C:\Users\you\AppData\Local\Temp\council-claude-plan.json how should we add offline support?
```

Optional bounded debate (never a live chat): `--debate-rounds 1` gives each disputed item's author one rebuttal turn; `--debate-rounds 2` adds one counter by the original critic. Hard caps: 6 items, 2 rounds.

## Typical Flows

```text
/council:review --background
/council:status
/council:result
```

```text
/council:adversarial --background look for race conditions and soft-delete mistakes
```

```text
/grok:review --background
/grok:rescue --write fix the failing unit test with minimal patch
```

## State And Environment

Job state is stored per workspace under:

- Council: `~/.claude/agent-council-state/council/<workspace-slug-hash>/`
- Grok: `~/.claude/agent-council-state/grok/<workspace-slug-hash>/`

Overrides:

| Variable | Meaning |
|----------|---------|
| `AGENT_COUNCIL_STATE_DIR` | Council state root |
| `AGENT_COUNCIL_GROK_STATE_DIR` | Grok state root |
| `GROK_BIN` / `GROK_PATH` | Path to `grok` binary |
| `GROK_COMPANION_PATH` | Path to `grok-companion.mjs` |
| `CODEX_COMPANION_PATH` | Path to `codex-companion.mjs` |

The plugins no longer use `CLAUDE_PLUGIN_DATA` for job state.

## Policy

Copy `.council.example.yml` to `.council.yml` for project defaults. Important keys:

```yaml
scope: auto
agent_timeout_minutes: 30
require_consensus_for: [auth, concurrency, data-loss, compliance, security]
skip_paths:
  - content/blog/**
peer_critique_severities: [P0, P1]
r2_effort: medium
debate_rounds: 0
debate_resume: false
solve_writer: claude
```

`debate_resume: true` lets Grok authors defend contested findings inside their own R1 session (context continuity via `--resume`); Codex debate turns stay fresh slim calls because its companion only supports resume-last.

`skip_paths` applies to Git status/diff pathspecs and untracked file body inclusion in the council deliberate/solve context; the cheaper `/council:review` and `/council:adversarial` paths delegate context collection to the codex/grok companions and do not apply `skip_paths`. `agent_timeout_minutes` bounds Codex/Grok subprocesses. `peer_critique_severities: [all]` critiques every finding.

Codex reasoning effort comes from `~/.codex/config.toml` (`model_reasoning_effort`). The council `codex_effort` policy key and `--codex-effort` flag are accepted for compatibility but ignored.

## Model Configuration

Prefer per-agent flags:

```text
/council:review --codex-model gpt-5.5 --grok-model grok-4.5
/grok:review --model grok-build
```

Grok effort can be passed with `--grok-effort`; Codex effort must be configured in Codex itself.

## Development

```bash
npm test
```

The test suite uses Node's built-in `node:test` runner and has no npm dependencies.

Release history is recorded in [CHANGELOG.md](CHANGELOG.md).

## License

MIT for this local toolkit. Codex plugin remains Apache-2.0 (OpenAI). Grok CLI is covered by xAI terms.
