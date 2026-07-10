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

/** Collect {agent, verdict} pairs from R1 result docs (skips absent verdicts). */
export function collectVerdicts(r1Results = []) {
  const out = [];
  for (const r of r1Results) {
    if (r?.skipped) continue;
    const verdict = r?.findings?.verdict ?? r?.verdict ?? null;
    if (verdict) out.push({ agent: r.agent, verdict: String(verdict) });
  }
  return out;
}
