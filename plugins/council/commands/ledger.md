---
description: Show and resolve the cross-run findings ledger (recognize known findings over time)
argument-hint: "[--status open|fixed|dismissed|ignored] [--resolve <fingerprint> fixed|dismissed|ignored|open]"
allowed-tools: Bash(node:*)
---

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/council-companion.mjs" ledger $ARGUMENTS
```

Every deliberation fingerprints its merged findings into a ledger, so later runs
show which findings were seen before and how many times. The report annotates each
finding with `seenBefore` / `timesSeen`.

- `ledger` lists tracked findings (most-recurring first) with status + fingerprint.
- `--status open|fixed|dismissed|ignored` filters.
- `--resolve <fingerprint> fixed|dismissed|ignored` marks the outcome (absence alone
  never auto-marks fixed, because reviews have varying scopes). `dismissed` = a false
  positive; it feeds the per-category calibration shown by `/council:overview`.
