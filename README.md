# Agent Council for Claude Code

Claude Code plugins that wire **Grok Build** and a **multi-agent council** (Codex + Grok) into the same workflow as [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc).

## Why a plugin (not only a skill)?

| Need | Skill alone | Plugin |
|------|-------------|--------|
| Reliable slash commands | weak | yes |
| Parallel Codex + Grok jobs | fragile | yes |
| `/status` · `/result` · `/cancel` | no | yes |
| Discover installed Codex companion | no | yes |
| Marketplace install / versioning | no | yes |

Skills are still included **inside** the plugins for prompting guidance. The runtime is Node companions.

## What you get

### Plugin `grok`

| Command | Purpose |
|---------|---------|
| `/grok:setup` | Check Grok CLI + auth |
| `/grok:review` | Read-only review (git working tree or `--base`) |
| `/grok:adversarial-review` | Challenge-style review + focus text |
| `/grok:rescue` | Hand a task to Grok |
| `/grok:status` · `result` · `cancel` | Job control |

Subagent: `grok:grok-rescue`.

### Plugin `council`

| Command | Purpose |
|---------|---------|
| `/council:setup` | Probe Codex companion + Grok + policy file |
| `/council:deliberate` | **Best:** 3-way independent think → peer critique |
| `/council:review` | Faster dual Codex + Grok (single round) |
| `/council:adversarial` | Dual adversarial review |
| `/council:status` · `result` · `cancel` | Council job control |

### Deliberate protocol (all three think, then evaluate)

```text
Round 1 (independent, no peeking)
  Claude  → writes .council-claude-r1.json
  Codex   → structured findings (parallel with Grok)
  Grok    → structured findings

Round 2 (peer critique)
  Grok  critiques Codex findings
  Codex critiques Grok findings
  both  critique Claude (if file provided)

Then Claude produces Fix / Verify / Ignore table
```

Structured JSON schema: `plugins/council/schemas/findings.schema.json`  
Policy example: `.council.example.yml` → copy to repo root as `.council.yml`

## Requirements

- **Node.js** ≥ 18.18
- **Claude Code** with plugin support
- **Codex** (recommended): `codex@openai-codex` plugin and/or `npm i -g @openai/codex` + `codex login`
- **Grok Build** CLI: [x.ai/cli](https://x.ai/cli) + `grok login`

## Install (local marketplace)

From Claude Code:

```text
/plugin marketplace add C:/Appgehoben/agent-council-cc
/plugin install grok@agent-council
/plugin install council@agent-council
/reload-plugins
```

If your Claude build expects a GitHub-style source, add to `~/.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "agent-council": {
      "source": {
        "source": "directory",
        "path": "C:\\Appgehoben\\agent-council-cc"
      }
    }
  },
  "enabledPlugins": {
    "grok@agent-council": true,
    "council@agent-council": true,
    "codex@openai-codex": true
  }
}
```

Then restart Claude Code or `/reload-plugins`.

### Smoke without installing

```bash
node plugins/grok/scripts/grok-companion.mjs setup --json
node plugins/council/scripts/council-companion.mjs setup --json
```

## Typical flows

### Dual review before merge

```text
/council:review --background
/council:status
/council:result
```

### Design challenge

```text
/council:adversarial --background look for race conditions and soft-delete mistakes
```

### Single agent

```text
/codex:review --background
/grok:review --background
```

### Rescue (one writer)

```text
/codex:rescue investigate the failing test
# or
/grok:rescue --write fix the failing unit test with minimal patch
# then
/council:review --background
```

## Architecture

```text
Claude Code
  ├─ codex@openai-codex     → Codex app server (existing)
  ├─ grok@agent-council     → Grok Build CLI (headless)
  └─ council@agent-council  → parallel orchestrator
         ├─ discovers codex-companion.mjs
         └─ discovers grok-companion.mjs or falls back to `grok`
```

Job state (default):

- Grok: `~/.claude/agent-council-state/grok/<workspace-slug-hash>/`
- Council: `~/.claude/agent-council-state/council/<workspace-slug-hash>/`

(or under `CLAUDE_PLUGIN_DATA` when Claude sets it)

## Environment overrides

| Variable | Meaning |
|----------|---------|
| `GROK_BIN` / `GROK_PATH` | Path to `grok` binary |
| `GROK_COMPANION_PATH` | Path to `grok-companion.mjs` |
| `CODEX_COMPANION_PATH` | Path to `codex-companion.mjs` |

## Does it really call Codex and Grok?

Yes — confirmed by code path + local setup probe:

| Agent | What runs |
|-------|-----------|
| **Codex** | `node …/codex-companion.mjs review` → your installed **OpenAI Codex plugin** → local `codex` CLI / app-server |
| **Grok** | `node …/grok-companion.mjs review` → local **`grok.exe`** (Grok Build headless) |
| **Claude** | Orchestrator only: slash command + synthesis of the report (not a third automated review process) |

`/council:setup --json` on this machine found both companions. A full dual review still spends tokens on both CLIs.

## Model configuration

### Defaults (recommended)

| Agent | Config file | Your current defaults (this machine) |
|-------|-------------|--------------------------------------|
| **Codex / GPT** | `~/.codex/config.toml` | `model = "gpt-5.5"`, `model_reasoning_effort = "xhigh"` |
| **Grok** | `~/.grok/config.toml` | `[models] default = "grok-4.5"`, `default_reasoning_effort = "high"` |
| **Claude Code** | Claude settings / session `/model` | separate — not controlled by council |

Example Codex:

```toml
# ~/.codex/config.toml
model = "gpt-5.5"
model_reasoning_effort = "xhigh"
```

Example Grok:

```toml
# ~/.grok/config.toml
[models]
default = "grok-4.5"
default_reasoning_effort = "high"
```

List Grok models: `grok models`.

### Per-run overrides (CLI flags)

Prefer **separate** flags (one model string is not valid for both vendors):

```text
/council:review --codex-model gpt-5.5 --grok-model grok-4.5
/grok:review --model grok-build
/codex:review --model gpt-5.4-mini
```

Also supported:

```text
--codex-effort high
--grok-effort high
```

Legacy `--model` on council still exists but applies to **both** if the specific flags are omitted — avoid it.

### Project-level (optional)

- Codex: project `.codex/config.toml` when the project is trusted
- Grok: project rules / config as documented by Grok Build (user-level `~/.grok/config.toml` is the main default)

## Limits (honest)

- Not a full clone of every Codex app-server feature (session transfer, etc.).
- Grok reviews use headless `grok` + git context / tools.
- Claude is **not** automatically a third parallel reviewer inside `/council:review` — it synthesizes the two external reports.
- “Always review each other” is a **workflow** (`/council:review` at merge time), not an infinite free loop.
- Do not run two write-rescues on the same branch without worktrees.

## License

MIT for this local toolkit. Codex plugin remains Apache-2.0 (OpenAI). Grok CLI is covered by xAI terms.
