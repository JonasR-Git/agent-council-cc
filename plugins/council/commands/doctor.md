---
description: Diagnose the council setup end-to-end (CLIs, state dir, window limits, live agent pings)
argument-hint: "[--no-ping] [--json]"
allowed-tools: Bash(node:*)
---

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/council-companion.mjs" doctor $ARGUMENTS
```

Runs a full self-test and prints an OK/PROBLEMS summary:
- CLI availability + versions (node, codex CLI + companion, grok CLI)
- state directory is writable
- Claude window limits reachable (OAuth usage endpoint)
- **live pings** to Codex and Grok (a one-sentence round trip each; costs a tiny
  amount of quota but proves the model/server actually responds - this is what
  catches "wrong model id" or a stale app-server that setup alone misses)

Use `--no-ping` for a fast, quota-free offline check (CLIs / state dir / limits only).

Exit code is non-zero when any check fails. Use before a big deliberate/solve run,
or first when a run behaves oddly.
