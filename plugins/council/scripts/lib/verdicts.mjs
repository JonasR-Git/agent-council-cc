/**
 * Verdict aggregation for the fix loop: decide when a diff has enough approvals
 * to stop iterating. The writer's own verdict never counts toward approval.
 */

const APPROVING = new Set(["approve", "approve_with_nits"]);
const BLOCKING = new Set(["request_changes", "block"]);

/**
 * @param {Array<{agent:string, verdict:string}>} verdicts
 * @param {{writer?:string, needed?:number}} opts
 */
export function evaluateApproval(verdicts, opts = {}) {
  const writer = opts.writer ?? null;
  const needed = opts.needed ?? 2;
  const counted = (verdicts ?? []).filter((v) => v && v.agent && v.agent !== writer);
  const approvals = counted.filter((v) => APPROVING.has(String(v.verdict).toLowerCase()));
  const blockers = counted.filter((v) => BLOCKING.has(String(v.verdict).toLowerCase()));
  return {
    approvals: approvals.map((v) => v.agent),
    blockers: blockers.map((v) => v.agent),
    voters: counted.map((v) => v.agent),
    needed,
    approved: approvals.length >= needed,
    excludedWriter: writer
  };
}

/**
 * The findings a fix loop must address before re-review: consensus, policy-
 * required-consensus, and any P0. Single-agent P1s are included only when an
 * agent actually blocked (else a lone shaky P1 churns the loop forever).
 * Conceded/ignored items are dropped.
 */
export function selectActionable(merged, opts = {}) {
  const anyBlocker = Boolean(opts.anyBlocker);
  return (merged?.all ?? [])
    .filter((f) => {
      if (f.debate?.stance === "concede" || f.ledgerStatus === "ignored") return false;
      const sev = String(f.severity);
      if (sev === "nit") return false; // nits never block a merge
      if (f.needsConsensus) return true; // policy-required consensus category
      if (sev === "P0") return true;
      if (f.consensus && (sev === "P1" || sev === "P2")) return true; // agreed real issues
      if (sev === "P1") return anyBlocker; // lone P1 only if someone blocked
      return false;
    })
    .map((f) => ({
      severity: f.severity,
      category: f.category,
      title: f.title,
      file: f.file ?? null,
      line: f.line ?? null,
      consensus: Boolean(f.consensus),
      agents: f.agents ?? []
    }));
}

/** Collect {agent, verdict} pairs from R1 result docs (skips absent verdicts). */
export function collectVerdicts(r1Results = []) {
  const out = [];
  for (const r of r1Results) {
    if (r?.skipped) continue;
    // A timed-out or parse-failed R1 yields a synthetic 'request_changes' with
    // parseOk:false - it must NOT count as a voter, else a peer timeout looks
    // like a real (blocking) verdict and the fixloop incomplete gate misses it.
    // The claude findings file has no status/timedOut and is always trustworthy.
    const untrustworthy =
      (r.status != null && r.status !== 0) || r.timedOut === true || r?.findings?.parseOk === false;
    if (untrustworthy) continue;
    const verdict = r?.findings?.verdict ?? r?.verdict ?? null;
    if (verdict) out.push({ agent: r.agent, verdict: String(verdict) });
  }
  return out;
}
