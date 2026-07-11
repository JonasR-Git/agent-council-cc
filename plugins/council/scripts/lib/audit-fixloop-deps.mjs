// Wiring for `audit fix --loop` (docs/enterprise-fix-design.md M3): compose the real
// engine pieces into the injectable deps runFixLoop consumes. The composition itself is
// where the council-flagged contract drift lived, so it is a separate, TESTABLE factory
// (runAuditReview + runAuditFix are injectable) rather than inline CLI glue.
//
// - review: runAuditReview over the codebase model. On the FIRST pass (full scope) it
//   advances a progressive unit window per pass (like endless); once the loop re-scopes
//   to changed files it reviews exactly those.
// - fix: runAuditFix on the actionable set, threading branch + stayOnBranch so the loop
//   continues ONE integration branch across passes.
// - expandScope: blast-radius (§7) — a change to a HUB file (fan-in >= threshold) forces
//   a full re-scope next pass ("no incremental discount for hub files"); a leaf change
//   stays narrow. Returns [] to signal "full re-scope" to the loop.
// - verdictsFor: the Tier-0 verdict map (empty until the detector is wired to gate; the
//   detector currently emits only observations, so this is honestly {} for now).

import { runAuditFix } from "./audit-fix.mjs";
import { runAuditReview } from "./audit-review.mjs";

export function makeFixLoopDeps(cwd, model, backends, options = {}, impl = {}) {
  const doReview = impl.runAuditReview ?? runAuditReview;
  const doFix = impl.runAuditFix ?? runAuditFix;
  const maxUnits = Math.max(1, options.maxUnits ?? 8);
  const hubFanIn = options.hubFanIn ?? 8;
  const files = model?.files ?? [];

  const review = async ({ budget, pass, changedFiles }) => {
    const scoped = changedFiles && changedFiles.length ? files.filter((f) => changedFiles.includes(f.id)) : files;
    const scopedModel = scoped === files ? model : { ...model, files: scoped };
    return doReview(cwd, scopedModel, backends, {
      budget,
      maxUnits,
      // Full-scope passes advance the hotspot window (progressive coverage); a
      // change-scoped pass reviews exactly the changed band from the top.
      unitOffset: changedFiles && changedFiles.length ? 0 : (pass - 1) * maxUnits,
      skipReduce: pass > 1, // the global SSOT reduce is over static input — run it once
      skipCodex: options.skipCodex,
      skipGrok: options.skipGrok,
      ledger: options.ledger
    });
  };

  const fix = async (actionable, ctx = {}) =>
    doFix(cwd, actionable, backends, {
      branch: ctx.branch,
      stayOnBranch: ctx.stayOnBranch,
      minSeverity: options.minSeverity ?? "P2",
      maxFixes: options.maxFixesPerPass ?? 10,
      claudeModel: options.claudeModel
    });

  const expandScope = (changed) => {
    const anyHub = changed.some((c) => (files.find((f) => f.id === c)?.fanIn ?? 0) >= hubFanIn);
    return anyHub ? [] : changed; // a hub change -> full re-scope next pass (design §7)
  };

  const verdictsFor = () => options.verdictMap ?? {};

  return { review, fix, expandScope, verdictsFor };
}
