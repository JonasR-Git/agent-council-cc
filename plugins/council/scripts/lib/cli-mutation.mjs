// mutationClass enforcement — the READ/WRITE safety boundary (docs/cli-surface-design.md, foundation #2).
//
// The INVIOLABLE rule of the redesign: read-only verbs (review, plan, solve) never modify tracked
// project source or git; only the writing verbs (fix, build) may — always test-gated on an isolated
// branch, never auto-merged. This module turns that rule into a STRUCTURAL guarantee rather than a
// convention: every resolved verb carries a mutationClass, and `assertCodeWriteAllowed(verb)` — called
// at the TOP of every code-writing path (immediately before runAuditFix / runBuild / the structure
// transform) — THROWS unless the verb is a working-tree writer. So a review/plan/solve/endless/run
// invocation that somehow reached a code writer fails LOUD instead of silently mutating tracked source.

/**
 * mutationClass per canonical verb:
 *   none         — pure read-only (review, plan, solve). review/plan/solve may write ARTIFACTS/reports
 *                  (--doc/--sarif/--write-map/PlanSpec) but NEVER tracked project source or git.
 *   state-only   — mutates plugin JOB/LEDGER/CONFIG state only (status: cancel + ledger --resolve;
 *                  setup: --init writes .council.yml). NEVER tracked project source.
 *   working-tree — may modify tracked project source on an isolated, test-gated branch (fix, build).
 */
export const VERB_MUTATION = {
  review: "none",
  fix: "working-tree",
  plan: "none",
  build: "working-tree",
  solve: "none",
  status: "state-only",
  setup: "state-only"
};

/**
 * Guard the entrance to a code writer. THROWS unless `verb` is a working-tree writer (fix/build).
 * Placed before runAuditFix / runBuild / the structure transform so review/plan/solve can NEVER reach
 * a tracked-source writer — the structural proof behind "review never writes tracked source".
 */
export function assertCodeWriteAllowed(verb) {
  const cls = VERB_MUTATION[verb];
  if (cls !== "working-tree") {
    throw new Error(
      `mutationClass violation: the "${verb}" verb (mutationClass=${cls ?? "unknown"}) must never write ` +
        `tracked project source. Only fix/build may reach a code writer.`
    );
  }
}
