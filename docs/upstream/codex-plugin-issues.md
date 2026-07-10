# Upstream reports for the OpenAI Codex Claude Code plugin

Two items discovered while building agent-council-cc against the Codex companion
(`~/.claude/plugins/cache/openai-codex/codex/<version>/scripts/codex-companion.mjs`).
File these against the codex plugin repo when convenient.

## 1. Bug: `cancel` builds a broken `taskkill /PID` under Git Bash on Windows

`codex-companion.mjs cancel <job-id>` terminates the worker via
`taskkill /PID <pid> /T /F`. Under Git Bash (MSYS) on Windows, the `/PID`,
`/T`, `/F` tokens are subject to MSYS path conversion, so the actually-executed
command becomes e.g. `taskkill C:/Program Files/Git/PID ...` and fails with:

```
FEHLER: Argument/Option ungueltig - "C:/Program Files/Git/PID".
```

Result: `cancel` cannot kill a running Codex job when invoked from a Git Bash
shell. Repro: start any background codex task, then `cancel` it from Git Bash.

Fix options: spawn `taskkill` with `shell:false` and explicit args (Node does not
MSYS-convert argv when not going through a shell), or set `MSYS_NO_PATHCONV=1`
for the taskkill invocation, or use the `taskkill.exe` absolute path with `--%`
stop-parsing semantics. agent-council-cc's own process layer avoids this by
spawning taskkill with `shell:false`.

## 2. Feature request: thread-precise `--resume <thread-id>` for `task`

`task` supports `--resume-last` (boolean) but not resuming a *specific* thread by
id. Multi-agent orchestrators that interleave several Codex threads (e.g. an R1
review thread and separate R2 critique threads) cannot reliably continue a
particular earlier thread - "resume last" picks whichever thread was most recent,
which is usually the wrong one.

Grok's CLI already supports `--resume <session-id>` and it works well for exactly
this (session-continuous debate turns). A matching `task --resume <thread-id>`
(the thread id is already surfaced in `status` output as "Codex session ID")
would let orchestrators give a Codex author its own prior context in follow-up
turns. Today agent-council-cc can only offer session-resume debates for Grok and
documents Codex as fresh-call-only.
