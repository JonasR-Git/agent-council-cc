---
description: Manage isolated git worktrees for single-writer solve implementations
argument-hint: "add|remove|list <slug> [--base <ref>] [--force]"
allowed-tools: Bash(node:*), Bash(git:*)
---

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/council-companion.mjs" worktree $ARGUMENTS
```

- `worktree add <slug> [--base <ref>]` creates branch `council-solve/<slug>` and a
  sibling worktree directory; the writer implements + commits there, leaving the
  main checkout free.
- `worktree remove <slug> [--force]` removes the worktree (the branch is kept so it
  can be reviewed/merged).
- `worktree list` shows active council-solve worktrees.

Use in `/council:solve` phase 4 so exactly one writer works in isolation.
