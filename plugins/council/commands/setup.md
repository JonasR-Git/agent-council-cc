---
description: Check council backends (Claude/Codex/Grok) and scaffold .council.yml
argument-hint: "[--init [--reviewers claude,codex,grok] [--claude-backend session|spawn] [--claude-model <id>] [--codex-model <id>] [--grok-model <id>] [--default-mode review|deliberate] [--force]]"
allowed-tools: Bash(node:*), Bash(grok:*), Bash(codex:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/council-companion.mjs" setup --json $ARGUMENTS
```

## Report mode (no `--init`)

Presents readiness per reviewer:
- **claude** - `session` backend is always reachable (it's the orchestrating you);
  `spawn` backend needs the Claude CLI logged in.
- **codex** - via the Codex plugin companion or the `codex` CLI (`codex login`).
- **grok** - via the `grok` CLI (`grok login`) and optionally the grok plugin.

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
