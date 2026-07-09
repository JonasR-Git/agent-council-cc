---
description: Run a steerable adversarial Grok review of local git state
argument-hint: "[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch] [focus text]"
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

Run an adversarial Grok review (read-only). Extra focus text after flags is allowed.

Raw arguments:
`$ARGUMENTS`

Rules:
- Do not fix code.
- Preserve user focus text.
- Prefer background for non-trivial diffs.

Foreground:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" adversarial-review $ARGUMENTS
```

Background:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" adversarial-review --background $ARGUMENTS
```

Then point the user to `/grok:status` / `/grok:result`.
