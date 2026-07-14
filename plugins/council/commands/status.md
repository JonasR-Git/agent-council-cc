---
description: Council job control (read-only) — status/list, live dashboard, result, wait, cancel, history, metrics, usage, ledger, fixloop, overview
argument-hint: "[job-id] [--result|--watch|--wait|--cancel|--history|--metrics|--usage|--ledger|--fixloop|--overview] [--summary|--html] [--follow] [--json]"
allowed-tools: Bash(node:*)
---

# Council job control

One command for a running/finished job — **read-only observation** (it inspects state
and reports; the only control it exercises is `--cancel`, which stops a running job, and
it never edits source). Pick **one** action by flag (default = list + status). No
`job-id` → the most recent job. The full action enum:

`--result | --watch | --wait | --cancel | --history | --metrics | --usage | --ledger | --fixloop | --overview`

Raw arguments: `$ARGUMENTS`

## Default — status

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/council-companion.mjs" status $ARGUMENTS
```
Present the output (running + recent jobs, or one job's state).

## `--watch` — live dashboard
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/council-companion.mjs" status --watch $ARGUMENTS
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
node "${CLAUDE_PLUGIN_ROOT}/scripts/council-companion.mjs" status --result $ARGUMENTS
```
Prefer `--summary` (merged findings / ranking / debate only, saves tokens); `--html`
writes a self-contained styled report to the job's artifacts dir. Present the report,
then a brief Claude synthesis (consensus vs unique P0). Do not re-run the review.

## `--wait` — block until done
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/council-companion.mjs" status --wait $ARGUMENTS
```
Run in the background so the process exit wakes the session. `--follow` streams each
phase to stderr; exits 0 when finished, 1 on `--timeout` (default 3600s).

## `--cancel` — stop a running job
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/council-companion.mjs" status --cancel $ARGUMENTS
```
Present the cancel result.

## Other read-only actions

Each is an action flag on `status`:

- **`--history`** — recent jobs across this workspace with their kind / agents / verdict.
- **`--metrics`** — per-kind / per-agent call, failure, and timeout stats.
- **`--usage`** — this workspace's job-level token/usage stats (for provider window
  limits use `/council:setup --usage`).
- **`--ledger`** — the findings ledger (open/resolved/dismissed findings tracked across
  runs).
- **`--fixloop`** — the decision state of an autonomous `/council:fix` loop
  (`stop-approved` / `fix-and-rereview` / `stop-escalate-to-human`).
- **`--overview`** — a combined snapshot across the above.

All are read-only reporting; add `--json` for machine output. Present the output.
