# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-07-10

First stable release. Now a single council plugin (the standalone grok plugin was removed; the council's Grok reviewer uses the `grok` CLI directly).

### Added

- `watch [job-id]`: live auto-refreshing dashboard for a running council job — a tidy, width-aligned boxed table with per-agent Round 1 state, R1/R2 progress bars, elapsed + remaining-time estimate, and (once the job completes) a findings breakdown: per-agent findings raised / shared / disputed, totals (consensus/unique/contested), a must-fix (P0/P1) highlight, and a severity histogram. ANSI-colored in a live TTY (plain when piped/`--once`/`--json`); mode-aware (no R2 bar for review/adversarial/solve); ETA bucketed by participant count. Redraws in a TTY; `--once`/`--json`/`--timeout` supported. Reconciles states the raw log can't express: session-backed Claude shows as `file` (not stuck running), a terminal job marks participating agents done, a failed job leaves them `unknown`; `cancelled` ends the loop; phase comes from `job.phase` (never a stray log banner); a hit `--timeout` reports and exits non-zero like `wait`.

- Separated Claude reviewer backend: `claude_backend: spawn` (or `--claude-backend spawn`, with `--claude-model`) runs an independent `claude -p` headless as the R1 Claude reviewer, decoupled from the orchestrating session so it can judge Phase C neutrally. Confined to a read-only tool allow-list (`Read`/`Glob`/`Grep`) with `--strict-mcp-config` and a defense-in-depth deny-list, since it reads untrusted diff content; prompt piped on stdin. Parsed R1 docs are stamped with the runner's identity (a spawned reviewer cannot spoof a peer via `{"agent":...}`). Default stays `session` (orchestrator writes Claude's R1 file).
- Configurable reviewers: `reviewers: [claude, codex, grok]` (or `--reviewers`) selects who participates; omitting an agent skips it. Explicit `--skip-claude` added alongside `--skip-codex`/`--skip-grok`.
- `setup --init`: scaffold a `.council.yml` from defaults plus `--reviewers`/`--claude-backend`/`--claude-model`/`--codex-model`/`--grok-model`/`--default-mode` (refuses to clobber without `--force`). `setup` report now shows per-reviewer reachability and the Claude backend; `doctor` gained an optional Claude-CLI check.
- `result --html`: self-contained styled HTML report (sortable severity-coloured findings table with consensus/policy/contested/seen badges, verdict chips, solve ranking, collapsed full report) written to the job's artifacts dir. All fields HTML-escaped; light/dark aware.
- `worktree add|remove|list`: isolated git worktrees for single-writer `/council:solve` implementations (branch `council-solve/<slug>`). Idempotent add, re-attaches a kept branch after remove (fixloop-safe), and refuses to remove a worktree with uncommitted changes unless `--force`.

### Fixed

- Verification (`--verify`) no longer fires an unbounded number of concurrent agent subprocesses: it runs through a bounded pool (`VERIFY_CONCURRENCY`, default 4) and no longer wastes spawns verifying consensus findings (which are protected and never demoted).
- Verification never lets a finding's own author refute it: when no independent peer verifier is available (the peer is skipped), the finding is left as-is instead of being self-verified and demoted.
- Agent `scope` overrides (`localized`/`cross-cutting`) now survive normalization and merging, so an explicit agent scope actually beats the heuristic (previously the field was dropped before `classifyScope` ran). A finding with a file but a null line is no longer misclassified as a precise/localized location.
- Fuzzy-merging findings no longer discards a known line number when a higher-severity duplicate has none.
- The cross-run findings ledger is now updated under a cross-process advisory lock (`withFileLock`), so two council jobs finishing at once no longer lose each other's fingerprints, and an explicit `fixed`/`ignored` status can't be clobbered by a concurrent finish.
- The R1 resume cache no longer carries a grok session id across processes: a resumed run's debate falls back to fresh calls instead of trying to resume a prior process's expired session.

### Housekeeping

- Removed dead code (`clearR1Cache`), narrowed the lib API surface (9 internal-only helpers un-exported), untracked the runtime `.claude/scheduled_tasks.lock`, and dropped a dev-only upstream memo. Docs/runtime now point at `/council:setup --init` instead of copying the repo-only `.council.example.yml`.
- De-duplicated verbatim helpers into `lib/util.mjs` (`isObject`, `firstLines`, `hashLite`, `formatExit`) and single-sourced `SEVERITY_RANK`, removing 8 copy-pasted definitions across `findings`/`solve`/`ledger`/`git-context`/`debate`/`deliberate` and the companion.
- Further consolidation: `lib/jsonl.mjs` (shared read/append/cap for the metrics, ledger and benchmark JSONL stores), `lib/stats.mjs` (`median`/`avg`/`clampScore`), `agents.buildAgentResult` (one canonical agent-result shape, replacing 6 literals) and `agents.withTempPrompt` (temp-prompt write/run/unlink, replacing 3 hand-rolled copies), and `policy.skippedAgents` for the skip-flag list.

## [0.5.0]

### Added

- Standalone Grok installation documentation and portable path examples.
- Cross-platform syntax linting, CI coverage, manifest checks, and synchronized version tooling.
- Structured-output schemas and validation for council protocols.
- Compact result summaries, sidecar artifacts, and versioned slim job state.
- Budget guardrails (`budget_guard`): refuse the expensive modes when a provider window is over threshold; fails closed when limits are unreadable.
- `/council:doctor`: end-to-end self-test with live agent pings (`--no-ping` for a fast offline check).
- Prompt-injection hardening: untrusted review input/evidence/plans are fenced with a per-run nonce.
- Live job progress (`onPhase`) surfaced in `status` and `wait --follow`.
- `/council:usage --limits --tokens`: 5h/weekly window limits (all three providers) and local token consumption.
- `/council:metrics`: persisted per-agent duration and per-kind wall-clock history.
- `/council:history` and a cross-run findings ledger (`seen Nx`), plus `deliberate --resume` of interrupted reviews.
- `/council:fixloop`: bounded review → fix → re-review orchestration with completeness/stuck gating.
- `/council:benchmark`: two-phase, blind peer-scored model benchmarking tracked over time.
- Grok session-resume debates (`debate_resume`).

### Changed

- Hardened atomic state writes and prune-aware artifact cleanup.
- Findings/plan/critique validation relaxed to structural contracts (values normalized in code).
- Per-repo `agent_timeout_minutes` raised to 45 (xhigh reviews of large diffs).

### Fixed

- Final-acceptance fixes (three council review rounds): R1 resume preserves the Grok session id (debate_resume works after `--resume`); `budget_guard` fails closed when any participating provider's limits are unreadable; `benchmark --judge-only` supersedes only the latest same-task record (chronological history preserved); the `fixloop` incomplete gate keys on peer completeness, and timed-out / parse-failed peers no longer count as voters, so a peer timeout correctly escalates instead of driving more fixes.

## [0.4.0]

### Added

- Repository hygiene checks and a portable test script.
- Explicit model handling for council agents.
- Grok override resilience when a configured model or effort is rejected.

## [0.3.0]

### Added

- Process and state hardening, solve and bounded-debate workflows, and cost controls.
- Markdown fence safety and self-review regression fixes.

## [0.2.0]

### Added

- Baseline marketplace import of the Grok and council plugins.

<!-- Compare links intentionally omitted: this repo has no canonical remote yet. -->
