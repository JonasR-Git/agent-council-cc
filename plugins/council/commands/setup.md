---
description: Set up the council — readiness report (default), diagnose (--check = doctor), scaffold .council.yml (--init), or provider usage/limits (--usage)
argument-hint: "[--init [--reviewers ...] [--claude-backend session|spawn] [--claude-model <id>] [--codex-model <id>] [--grok-model <id>] [--force]] [--check [--no-ping] [--json]] [--usage [--days <n>]]"
allowed-tools: Bash(node:*), Bash(grok:*), Bash(codex:*)
---

The `setup` verb has four actions: the **readiness report** (default), **`--check`**
(diagnose), **`--init`** (scaffold), and **`--usage`** (provider limits). If `--check`
is present, jump to **Check mode**; if `--usage` is present, jump to **Usage mode**.
Otherwise (readiness report / `--init`) run:

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

## Check mode (`--check`)

Diagnose the setup end-to-end:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/council-companion.mjs" setup --check $ARGUMENTS
```

Runs a full self-test and prints an OK/PROBLEMS summary: CLI availability + versions,
state dir writable, Claude window limits reachable, and **live pings** to Codex and
Grok (a one-sentence round trip each — this is what catches a wrong model id or a stale
app-server). It also warns (Appendix D) if a fix auto-apply consent is enabled without
a valid out-of-tree trust record, or if the policy file is world-writable. Use
`--no-ping` for a fast, quota-free offline check; exit code is non-zero when any check
fails. Run it before a big deliberate/solve run, or first when a run behaves oddly.

## Usage mode (`--usage`)

Provider window limits + local token/job stats:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/council-companion.mjs" setup --usage --limits --tokens $ARGUMENTS
```

- `--limits`: Claude 5h + weekly % (live OAuth endpoint), Codex 5h + weekly % (local
  `~/.codex/sessions`), Grok weekly % (local billing log; no 5h window).
- `--tokens`: token consumption over the last `--days` (default 7) from the local
  session logs of all three CLIs.
- Always included: this workspace's job stats (per-kind, per-agent call/failure/timeout).

For a deeper health check (live agent pings), use `/council:setup --check`.
