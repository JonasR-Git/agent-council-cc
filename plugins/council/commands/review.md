---
description: Parallel multi-agent review (Codex + Grok) of local git changes
argument-hint: "[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch] [--codex-model <id>] [--grok-model <id>] [--skip-codex] [--skip-grok]"
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

Run a **council review**: real **Codex CLI** (via openai codex-plugin companion) and real **Grok Build CLI** review the same target in parallel. You (Claude) synthesize afterward — Claude is not a third automated reviewer here.

Raw arguments:
`$ARGUMENTS`

Rules:
- Review-only. Do not implement fixes in this command.
- Prefer `--background` for non-trivial diffs.
- Models: use **separate** flags `--codex-model` and `--grok-model` (do not use one `--model` for both vendors).
- Defaults if omitted: Codex `~/.codex/config.toml`, Grok `~/.grok/config.toml`.
- If neither `--wait` nor `--background` is set, recommend background unless the change is tiny (1–2 files).

Foreground:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/council-companion.mjs" review $ARGUMENTS
```

Background:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/council-companion.mjs" review --background $ARGUMENTS
```

After background launch, tell the user to use `/council:status` and `/council:result`.

When results are available (foreground output or after `/council:result`):
1. Present the full council report.
2. Add a short **Claude synthesis**: consensus findings, unique P0s, ignore pure nits unless free.
3. Do not auto-fix unless the user asks.
