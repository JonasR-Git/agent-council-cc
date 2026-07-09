---
name: grok-cli-runtime
description: How to invoke the local Grok Build CLI from Claude Code via this plugin.
---

# Grok CLI runtime

Prefer plugin commands:

- `/grok:setup`
- `/grok:review` / `/grok:adversarial-review`
- `/grok:rescue`
- `/grok:status` / `/grok:result` / `/grok:cancel`

Companion script (from plugin root):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/grok-companion.mjs" <command> [args]
```

Direct CLI fallback when the plugin is unavailable:

```bash
grok -p "..." --cwd . --always-approve --disallowed-tools "search_replace"
```

Auth: `grok login`. Config: `~/.grok/config.toml`.

For multi-model review (Codex + Grok together), use the **council** plugin: `/council:review`.
