---
description: Check whether the local Grok Build CLI is ready
argument-hint: ""
allowed-tools: Bash(node:*), Bash(grok:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" setup --json $ARGUMENTS
```

Present the setup output to the user.
If Grok is installed but not authenticated, tell them to run `!grok login`.
If Grok is missing, point them to https://x.ai/cli and ensure `grok` is on PATH.
