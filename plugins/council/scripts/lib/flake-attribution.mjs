// SSOT for "a RED suite after a change — pre-existing flake (keep) or a real regression (revert)?".
//
// Both write paths must judge a flaky red the SAME way: the single-file fixer (audit-fix.mjs) and the M9
// multi-file structure transform (council-companion's runFullSuite). This is the shared, PURE decision —
// the git stash / suite-run orchestration stays at each call site (it needs a real repo), but the verdict
// lives here so it can be exhaustively unit-tested and can never drift between the two paths.
//
// Reverting a CORRECT change over someone else's flaky test is the exact "wrong/flaky tests block correct
// fixes" failure the operator asked to defend against. The rule (mirrors the original inline logic): the
// change is a pre-existing flake ONLY when the CLEAN baseline is ALSO red AND the change does not INCREASE
// the count of failing test files. Fail-SAFE — every uncertainty (unrestored tree, green baseline,
// unparseable counts, higher post count) resolves to { ok:false } so the change reverts.
//
// COUNT-based, not failing-set-based: a change that breaks file X exactly as an unrelated flaky file Y
// flips green is not caught here (rare). The caller's other gates are the backstop — for M9 that is the
// public-API check AND a unanimous §6 council over the exact staged diff.

/**
 * @param {object} p
 * @param {boolean} p.restored   the change was successfully restored after the baseline probe (stash pop ok)
 * @param {boolean} p.baseGreen  the CLEAN baseline suite (change removed) passed
 * @param {number|null} p.postFails  failing-file count WITH the change (null = unparseable)
 * @param {number|null} p.baseFails  failing-file count at the clean baseline (null = unparseable)
 * @returns {{ ok: boolean, attributedFlake: boolean, reason: string }}
 */
export function attributeRedSuite({ restored, baseGreen, postFails, baseFails }) {
  if (!restored) {
    return { ok: false, attributedFlake: false, reason: "could not restore the change after the baseline probe — fail-safe revert" };
  }
  if (baseGreen) {
    return { ok: false, attributedFlake: false, reason: "baseline suite is GREEN without this change → the change caused the red → revert" };
  }
  if (postFails == null || baseFails == null) {
    return { ok: false, attributedFlake: false, reason: "could not parse failing-file counts → cannot attribute → revert" };
  }
  if (postFails <= baseFails) {
    return {
      ok: true,
      attributedFlake: true,
      reason: `baseline ALREADY red (${baseFails} file(s) fail); the change adds no new failing file (${postFails}) → pre-existing flake, kept (NOT verified-green)`
    };
  }
  return { ok: false, attributedFlake: false, reason: `the change INCREASES failing files (${baseFails} → ${postFails}) → a real regression → revert` };
}
