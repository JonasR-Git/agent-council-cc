// Wiring for `audit fix --loop` (docs/enterprise-fix-design.md M3): compose the real
// engine pieces into the injectable deps runFixLoop consumes. The composition is a
// separate, TESTABLE factory (runAuditReview + runAuditFix injectable) because it is
// exactly where the council found contract drift.
//
// - review: runAuditReview over the codebase model. Full-scope passes advance a
//   PROGRESSIVE hotspot window keyed to a FULL-SCOPE-pass counter (NOT the loop's global
//   pass number, which mixes scope modes) and WRAP at the end so an overrun re-reviews
//   the top band instead of returning an empty review the loop would misread as "dry".
//   A localized pass reviews exactly the changed files; if none of them are known model
//   units it falls back to full scope rather than reviewing nothing.
// - fix: runAuditFix on the actionable set, threading branch + stayOnBranch so ONE
//   integration branch continues across passes.
// - expandScope: blast-radius (§7) — a HUB-file change (fan-in >= threshold) forces a
//   full re-scope next pass; a leaf change stays narrow. NOTE (MVP limitation): the true
//   dependent SET isn't cheaply available (the codebase model exposes fan-in as a COUNT,
//   not importer ids), so a covered dependent regression is caught by the per-fix +
//   integration test gates, and an UNCOVERED one on a leaf edit can be missed until the
//   model exposes import edges. Documented gap.
// - verdictsFor: the Tier-0 verdict map (empty until the detector is wired to gate; it
//   currently emits only observations, so this is honestly {}).

import { runAuditFix } from "./audit-fix.mjs";
import { runAuditReview } from "./audit-review.mjs";

export function makeFixLoopDeps(cwd, model, backends, options = {}, impl = {}) {
  const doReview = impl.runAuditReview ?? runAuditReview;
  const doFix = impl.runAuditFix ?? runAuditFix;
  const maxUnits = Math.max(1, options.maxUnits ?? 8);
  const hubFanIn = options.hubFanIn ?? 8;
  const files = model?.files ?? [];
  const nonTestCount = Math.max(1, files.filter((f) => !f.isTest).length);
  let fullPasses = 0; // counts ONLY full-scope passes, so the window advance is honest

  const review = async ({ budget, changedFiles }) => {
    const scopedFiles = changedFiles && changedFiles.length ? files.filter((f) => changedFiles.includes(f.id)) : null;
    let reviewFiles;
    let offset = 0;
    if (scopedFiles && scopedFiles.length) {
      reviewFiles = scopedFiles; // localized pass: review the changed band from the top
    } else {
      // Full scope (first pass, hub-forced full, or empty-scoped fallback): advance the
      // window by full-scope passes and WRAP so an overrun never returns an empty review.
      reviewFiles = files;
      offset = (fullPasses * maxUnits) % nonTestCount;
      fullPasses += 1;
    }
    const scopedModel = reviewFiles === files ? model : { ...model, files: reviewFiles };
    return doReview(cwd, scopedModel, backends, {
      budget,
      maxUnits,
      unitOffset: offset,
      skipReduce: fullPasses > 1, // the SSOT reduce is over static input — run it once
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
      allowUntested: options.allowUntested,
      coverage: options.coverage, // §5 coverage gate (a fix on an unexecuted line -> propose-only)
      claudeModel: options.claudeModel
    });

  const expandScope = (changed) => {
    const anyHub = changed.some((c) => (files.find((f) => f.id === c)?.fanIn ?? 0) >= hubFanIn);
    return anyHub ? [] : changed; // a hub change -> full re-scope next pass (design §7)
  };

  const verdictsFor = () => options.verdictMap ?? {};

  return { review, fix, expandScope, verdictsFor };
}
