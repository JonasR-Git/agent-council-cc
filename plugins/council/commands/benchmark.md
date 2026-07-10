---
description: Benchmark the agents on the same task with blind peer scoring; track which model wins over time
argument-hint: "[--task-file <path>] [--category <c>] [--stats] [task text]"
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

## Notes
- Judges score answers with the author hidden (fair comparison).
- Read-only only; do not benchmark tasks that require writing/committing.
