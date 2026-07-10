---
description: Live dashboard for a running council job (per-agent R1/R2 progress + ETA)
argument-hint: "[job-id] [--interval <s>] [--once] [--json]"
allowed-tools: Bash(node:*)
---

Show a live, auto-refreshing dashboard for a background council job: per-agent
Round 1 state (done / running / pending / skipped), Round 2 critique progress,
elapsed time, and an ETA from this repo's history.

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/council-companion.mjs" watch $ARGUMENTS
```

- No `job-id` → the most recent job.
- In a real terminal it redraws every `--interval` seconds (default 2) until the
  job finishes. **Tip:** run it in your own terminal pane via the `!` prefix for
  the smoothest live view.
- `--once` (or non-TTY output) prints a single snapshot instead of redrawing —
  this is what shows when invoked through the chat.
- `--json` returns the snapshot as structured data.

Pair with `/council:status` (one-line state) and `/council:result <job>` (final
report). To block until done instead of watching, use `/council:wait --follow`.
