---
description: Set up the council — check backends, scaffold .council.yml, or show provider usage/limits
argument-hint: "[--init [--reviewers ...] [--claude-backend session|spawn] [--claude-model <id>] [--codex-model <id>] [--grok-model <id>] [--force]] [--usage [--days <n>]]"
allowed-tools: Bash(node:*), Bash(grok:*), Bash(codex:*)
---

If `--usage` is present, jump to **Usage mode** below. Otherwise run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/council-companion.mjs" setup --json $ARGUMENTS
```

## Report mode (no `--init`)

Presents readiness per reviewer:
- **claude** - `session` backend is always reachable (it's the orchestrating you);
  `spawn` backend needs the Claude CLI logged in.
- **codex** - via the Codex plugin companion or the `codex` CLI (`codex login`).
- **grok** - via the `grok` CLI (`grok login`).

Only agents listed in `reviewers` are required for READY. Present the report and call
out any missing backend with its suggested next step.

## Scaffold mode (`--init`)

Writes a `.council.yml` in the repo root from defaults plus any overrides:

```bash
# Independent Claude reviewer (Opus) + Codex + Grok, deliberate by default
node "${CLAUDE_PLUGIN_ROOT}/scripts/council-companion.mjs" setup --init \
  --reviewers claude,codex,grok --claude-backend spawn --claude-model claude-opus-4-8
```

- Refuses to overwrite an existing `.council.yml` unless `--force` is passed.
- Flags: `--reviewers`, `--claude-backend`, `--claude-model`, `--codex-model`,
  `--grok-model`, `--default-mode`. Anything not given keeps the documented default.
- Logins are per-CLI, not stored here: run `codex login` / `grok login`, and for the
  Claude spawn backend run `claude` once so the CLI is authenticated.

Install commands if a backend is missing: Codex `npm i -g @openai/codex`; Grok
`curl -fsSL https://x.ai/cli/install.sh | bash` (binary at `~/.grok/bin/grok`; set
`GROK_BIN` if it exists but isn't on PATH); Claude `npm i -g @anthropic-ai/claude-code`.

## Usage mode (`--usage`)

Provider window limits + local token/job stats:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/council-companion.mjs" usage --limits --tokens $ARGUMENTS
```

- `--limits`: Claude 5h + weekly % (live OAuth endpoint), Codex 5h + weekly % (local
  `~/.codex/sessions`), Grok weekly % (local billing log; no 5h window).
- `--tokens`: token consumption over the last `--days` (default 7) from the local
  session logs of all three CLIs.
- Always included: this workspace's job stats (per-kind, per-agent call/failure/timeout).

For a deeper health check (live agent pings), use `/council:doctor`.
