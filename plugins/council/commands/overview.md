---
description: Cross-run findings overview with per-category calibration (model-agnostic)
argument-hint: "[--limit <n>] [--json]"
allowed-tools: Bash(node:*)
---

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/council-companion.mjs" overview $ARGUMENTS
```

Summarizes every finding the council has ever recorded (via the ledger), grouped by
**category** — how many, how often they recurred, how many reached consensus, and,
from resolved outcomes, a **calibration** per category: the share of resolved findings
that turned out real (`fixed`/`ignored`) vs false (`dismissed`).

Deliberately model-agnostic: it tracks findings and outcomes, never model reputation
(models get swapped). Resolve outcomes with:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/council-companion.mjs" ledger --resolve <fingerprint> fixed|dismissed|ignored
```

Use it to answer "are the council's security findings usually real?" and to spot
recurring (systemic) issues over time.
