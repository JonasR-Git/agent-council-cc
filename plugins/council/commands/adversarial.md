---
description: Parallel adversarial review (Codex + Grok) with optional focus text
argument-hint: "[--wait|--background] [--base <ref>] [--codex-model <id>] [--grok-model <id>] [focus text]"
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

Parallel **adversarial** council review (real Codex + real Grok). Extra focus text is allowed (e.g. auth, races, soft-delete).

Raw arguments:
`$ARGUMENTS`

Models: `--codex-model` / `--grok-model` (separate). Defaults from `~/.codex/config.toml` and `~/.grok/config.toml`.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/council-companion.mjs" adversarial $ARGUMENTS
```

Prefer background for large diffs. Synthesize findings after results; do not auto-fix.
