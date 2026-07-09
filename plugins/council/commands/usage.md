---
description: Show provider window limits (5h/weekly), local token usage, and council job statistics
argument-hint: "[--limits] [--tokens] [--days <n>] [--json]"
allowed-tools: Bash(node:*)
---

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/council-companion.mjs" usage --limits --tokens $ARGUMENTS
```

What each part shows:

- `--limits` - the window quotas the user actually cares about:
  - **Claude**: 5h + weekly utilization % with reset times, fetched live from the OAuth
    usage endpoint using the local Claude Code credentials (undocumented endpoint - may
    change; the token is only sent to api.anthropic.com).
  - **Codex**: 5h + weekly used % with reset times, parsed **locally** from the newest
    rollout snapshot in `~/.codex/sessions` (no network).
  - **Grok**: not exposed locally or headless; point the user to the xAI console.
- `--tokens` - token consumption over the last `--days` (default 7), parsed from the
  local session logs of all three CLIs (`~/.claude`, `~/.codex`, `~/.grok`).
- Always included: council job statistics for this workspace (jobs per kind, per-agent
  call/failure/timeout counts).

Notes for presenting: usage stats count finished jobs only; failed calls are included in
`calls` with a separate `failures` column.
