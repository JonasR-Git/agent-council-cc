---
description: Benchmark the agents on the same task with blind peer scoring; track which model wins over time
argument-hint: "[--task-file <path>] [--claude-answer-wait <path>] [--judge-only] [--category <c>] [--stats] [task text]"
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), Write
---

# Council benchmark

Give all three agents the same task, then have each blind-score the others' answers
(1-10). Persisted over time so you can see which model is worth what for which kind
of task. Use **read-only** tasks (explain/analyze/design) — this is not a writer.

Raw arguments: `$ARGUMENTS`

## Run a benchmark
1. Write the task to an OS temp file (outside the repo).
2. Start the companion; write your own answer in parallel to a temp file:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/council-companion.mjs" benchmark \
     --task-file "<ostemp>/bench-task.md" --claude-answer "<ostemp>/bench-claude.md" \
     --category "<optional label>"
   ```
   Answer the task yourself (independently, no peeking) into the `--claude-answer`
   file before/while Codex and Grok answer.
3. The report ranks agents by average blind peer score with each judge's rationale.

## See trends
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/council-companion.mjs" benchmark --stats
```
Shows per-agent runs, wins, and average score across all recorded benchmarks.

## Symmetric judging (two-phase, for a fair ranking)
By default Codex and Grok judge each other (1 judge each) and Claude's answer gets 2 —
so the default ranking has **unequal judge counts** (the report flags this). For a fair
comparison where every answer has the same number of judges, run two phases:

1. **Answer phase** (above) — the companion persists all answers to files under the
   state dir (path shown in the report) and records the run.
2. **Judge phase** — read the persisted answers, write your own blind scores as JSON,
   then re-run judge-only against the same task (no re-answering):
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/council-companion.mjs" benchmark --judge-only \
     --task-file "<same task file>" --claude-judgements "<ostemp>/bench-claude-judge.json"
   ```
   with `{ "codex": {"score": 7, "rationale": "..."}, "grok": {"score": 8, "rationale": "..."} }`.

Also: pass `--claude-answer-wait <path> --wait-timeout 600` (instead of `--claude-answer`)
so a parallel Claude answer is awaited, never silently dropped.

## Notes
- Blind scoring is nominal — a model may still infer authorship from style, so treat
  scores as indicative, not fully independent.
- Read-only only; do not benchmark tasks that require writing/committing.
