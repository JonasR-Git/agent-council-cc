// Autonomy dial (docs/enterprise-fix-design.md §2/§8). Maps a level onto the gate
// config the fix layer uses: which findings COMMIT vs stay PROPOSALS. The safety of the
// aggressive default comes from branch isolation + the measured gates + the human's
// final merge review — NOT from asking the human mid-run — so the dial only moves the
// commit/propose line; it never makes the loop pause. Pure DATA + pure functions.

const RANK = { P0: 0, P1: 1, P2: 2, nit: 3 };

export const AUTONOMY_LEVELS = ["aggressive", "conservative", "propose-only", "per-run"];

// level -> { apply, minSeverity, label, description }. `apply:false` means commit
// nothing (a pure audit++); `minSeverity` is the least-severe finding still committed.
const CONFIG = {
  aggressive: { apply: true, minSeverity: "P2", label: "aggressive", description: "commit everything that passes the measured gates; only machine-unprovable classes stay proposals" },
  conservative: { apply: true, minSeverity: "P1", label: "conservative", description: "commit only P0/P1; P2/nits are proposals" },
  "propose-only": { apply: false, minSeverity: "P0", label: "propose-only", description: "commit nothing; produce the full proposal set (a pure audit)" }
};

/**
 * Resolve an autonomy level to its gate config. `aggressive` is the default (unknown
 * levels fall back to it). For `per-run`, the caller supplies apply + minSeverity.
 */
export function resolveAutonomy(level, perRun = {}) {
  if (level === "per-run") {
    const minSeverity = RANK[perRun.minSeverity] != null ? perRun.minSeverity : "P2";
    return { apply: perRun.apply !== false, minSeverity, label: "per-run", description: "explicit per-run gate config" };
  }
  return CONFIG[level] ?? CONFIG.aggressive;
}

/** Would a finding of this severity COMMIT (vs stay a proposal) at this autonomy level? */
export function commitsAt(level, severity, perRun = {}) {
  const cfg = resolveAutonomy(level, perRun);
  if (!cfg.apply) return false;
  return (RANK[severity] ?? RANK.P2) <= (RANK[cfg.minSeverity] ?? RANK.P2);
}
