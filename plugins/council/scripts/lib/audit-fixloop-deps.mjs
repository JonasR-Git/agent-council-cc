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
import { normalizeFindings } from "./audit-normalize.mjs";
import { runAuditReview } from "./audit-review.mjs";

/** file -> Set(peer files that share a duplicate cluster with it). */
function buildDupPeers(dupClusters = []) {
  const peers = new Map();
  for (const cluster of dupClusters) {
    const inCluster = [...new Set((cluster.locations ?? []).map((l) => l.file).filter(Boolean))];
    for (const f of inCluster) {
      if (!peers.has(f)) peers.set(f, new Set());
      for (const g of inCluster) if (g !== f) peers.get(f).add(g);
    }
  }
  return peers;
}

export function makeFixLoopDeps(cwd, model, backends, options = {}, impl = {}) {
  const doReview = impl.runAuditReview ?? runAuditReview;
  const doFix = impl.runAuditFix ?? runAuditFix;
  const maxUnits = Math.max(1, options.maxUnits ?? 8);
  const hubFanIn = options.hubFanIn ?? 8;
  const files = model?.files ?? [];
  const nonTestCount = Math.max(1, files.filter((f) => !f.isTest).length);
  const importersOf = model?.graph?.importers ?? {};
  const dupPeers = buildDupPeers(model?.dupClusters);
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
    const rev = await doReview(cwd, scopedModel, backends, {
      budget,
      maxUnits,
      unitOffset: offset,
      skipReduce: fullPasses > 1, // the SSOT reduce is over static input — run it once
      skipCodex: options.skipCodex,
      skipGrok: options.skipGrok,
      // B2 (council grok-1): thread skipClaude too, else the fix loop spawns the Claude finder
      // even when the user opted out (reviewers:[codex,grok] / --skip-claude), inflating cost.
      skipClaude: options.skipClaude,
      ledger: options.ledger
    });
    // Surface a top-level `ran` the loop can trust. runAuditReview swallows backend
    // failures (rate-limit / unreachable / undispatched) into 0 findings WITHOUT throwing,
    // so the loop must distinguish "reviewed, found nothing" (dry — real) from "couldn't
    // review". Key on unitsSELECTED, not unitsAttempted: if units were selected (there WAS
    // work) but none produced a review — whether they failed OR were never dispatched (no
    // reachable reviewer, budget-starved) — that is NOT convergence → ran:false. Only a
    // genuinely empty scope (0 selected) stays ran:true.
    // Assign the canonical LENS to each finding. The one-shot `audit` path does this via
    // normalizeFindings; the loop path did NOT — so downstream tierOfLens(f.lens) saw
    // undefined and dropped EVERY loop finding into the Quality tier (id 3), silently
    // disabling structure-first --per-tier staging. Normalizing here repairs tier gating.
    // BUT normalizeFindings canonicalizes to {location:{path,startLine}} and DROPS the top-level
    // file/line + refuter flags. runAuditFix keys on f.file (ineligibleReason "no target file") and
    // the gate treats f.refuted as propose-only — so without re-attaching them the loop rejected
    // EVERY finding and never auto-fixed anything (council P0, empirically confirmed). Re-attach the
    // operational fields onto the canonical shape (normalizeFindings is a pure 1:1 map, so index i
    // aligns with the raw finding). file/line come from the canonical location (index-independent).
    const rawFindings = rev?.findings ?? [];
    const findings = normalizeFindings(rawFindings, {}).map((nf, i) => ({
      ...nf,
      file: nf.location?.path ?? rawFindings[i]?.file,
      line: nf.location?.startLine ?? rawFindings[i]?.line,
      verified: rawFindings[i]?.verified,
      refuted: rawFindings[i]?.refuted,
      agents: rawFindings[i]?.agents ?? nf.agents
    }));
    const cov = rev?.coverage ?? {};
    const selected = cov.unitsSelected ?? 0;
    const reviewed = cov.unitsReviewed ?? 0;
    // ran:false must not DISCARD real findings (council Codex C2 P2): on a budget-starved pass where no
    // unit could be dispatched but the reserved global SSOT reduce still ran and produced a structural
    // finding, keying ran solely on unitsReviewed dropped that finding before it was ever gated. A pass
    // that yielded ANY finding (from a unit OR the reduce) DID run — surface it; only a genuinely empty
    // undispatched pass (selected>0, reviewed=0, no findings) is the "couldn't review" stop.
    return { ...rev, findings, ran: reviewed > 0 || selected === 0 || findings.length > 0 };
  };

  const fix = async (actionable, ctx = {}) =>
    doFix(
      cwd,
      actionable,
      backends,
      {
        branch: ctx.branch,
        stayOnBranch: ctx.stayOnBranch,
        minSeverity: options.minSeverity ?? "P2",
        maxFixes: options.maxFixesPerPass ?? 10,
        allowUntested: options.allowUntested,
        coverage: options.coverage, // §5 coverage gate (a fix on an unexecuted line -> propose-only)
        claudeModel: options.claudeModel,
        // §6: consented council-gated auto-apply. sensitiveAutoApply only takes effect in
        // runAuditFix when a reviewPatch is ALSO injected (both are threaded from the CLI).
        sensitiveAutoApply: options.sensitiveAutoApply,
        // Rate-limit resilience must reach the layer where the 429 is actually thrown
        // (applyFix / reviewPatch) — the loop-level wrapper never sees it because
        // runAuditFix records a per-fix failure instead of throwing.
        retryOnLimit: options.retryOnLimit,
        // Pin the ledger's baseBranch to the loop's TRUE base (not git.currentBranch(), which on a
        // continuation pass is the integration branch → false durable promotion; council Opus O7).
        ledgerBaseBranch: options.ledgerBaseBranch
      },
      options.reviewPatch ? { reviewPatch: options.reviewPatch } : {}
    );

  // Blast radius (§7): re-scope the next pass to the changed files PLUS their real
  // dependents (importers, from the graph) and dup-cluster peers (editing B can flip A's
  // duplicate status). If that set is a large fraction of the repo (a hub), fall back to a
  // full re-scope — cheaper + more honest than a huge scoped list.
  const expandScope = (changed) => {
    const set = new Set(changed);
    for (const c of changed) {
      for (const imp of importersOf[c] ?? []) set.add(imp);
      for (const peer of dupPeers.get(c) ?? []) set.add(peer);
    }
    if (set.size > Math.max(hubFanIn, Math.ceil(nonTestCount * 0.5))) return [];
    return [...set];
  };

  const verdictsFor = () => options.verdictMap ?? {};

  // The full-scope window cursor (fullPasses) lives in this closure but must SURVIVE a --resume: it
  // drives the progressive unitOffset, so a resumed run that reset it to 0 would re-review the first
  // window and never reach later units (council Codex C2 P1). Expose it so runFixLoop persists it in
  // the checkpoint and restores it here on resume.
  const windowState = { get: () => fullPasses, set: (n) => { fullPasses = Math.max(0, Math.floor(Number(n) || 0)); } };

  return { review, fix, expandScope, verdictsFor, windowState };
}
