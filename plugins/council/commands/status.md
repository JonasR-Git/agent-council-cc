---
description: Council job control — list/status, live dashboard, result, wait, cancel
argument-hint: "[job-id] [--watch] [--result [--summary|--html]] [--wait [--follow]] [--cancel]"
allowed-tools: Bash(node:*)
---

# Council job control

One command for a running/finished job. Pick the action by flag (default = list +
status). No `job-id` → the most recent job.

Raw arguments: `$ARGUMENTS`

## Default — status

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/council-companion.mjs" status $ARGUMENTS
```
Present the output (running + recent jobs, or one job's state).

## `--watch` — live dashboard
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/council-companion.mjs" watch $ARGUMENTS
```
Per-agent R1 state, R2 progress, elapsed + ETA, and (on completion) a findings
breakdown. Redraws in a real terminal (**tip:** run it in your own pane via `!` for
the smooth live view); prints a single snapshot when piped/`--once`/`--json`.

Add **`--md`** for a rich Markdown snapshot that renders in the chat (a real table
with emoji status 🟢🟡⚪, Unicode bars, severity squares 🟥🟧🟨, a consensus badge,
live per-agent `raised`, and a `Δ since last update` line vs the previous `--md`
call). Use this to post the state in chat; use the plain box for a terminal pane.

## `--result` — stored report
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/council-companion.mjs" result $ARGUMENTS
```
Prefer `--summary` (merged findings / ranking / debate only, saves tokens); `--html`
writes a self-contained styled report to the job's artifacts dir. Present the report,
then a brief Claude synthesis (consensus vs unique P0). Do not re-run the review.

## `--wait` — block until done
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/council-companion.mjs" wait $ARGUMENTS
```
Run in the background so the process exit wakes the session. `--follow` streams each
phase to stderr; exits 0 when finished, 1 on `--timeout` (default 3600s).

## `--cancel` — stop a running job
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/council-companion.mjs" cancel $ARGUMENTS
```
Present the cancel result.
