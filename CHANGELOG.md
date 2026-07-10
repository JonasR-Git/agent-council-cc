# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

- Final-acceptance fixes: R1 resume now preserves the Grok session id (debate_resume works after `--resume`); `fixloop-status` escalates instead of recommending more fixes on an incomplete council; `budget_guard` fails closed when any participating provider's limits are unreadable; `benchmark --judge-only` supersedes the answer-phase record instead of double-counting.

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
