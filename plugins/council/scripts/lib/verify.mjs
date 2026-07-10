import {
  interpolate,
  loadPrompt,
  makeFenceNonce,
  runCodexStructured,
  runGrokStructured
} from "./agents.mjs";
import { extractJsonObject } from "./findings.mjs";

/**
 * Verification-first: before surfacing findings, ask an agent that did NOT raise
 * the finding to REFUTE it (small context: just the finding + its local evidence,
 * at a low effort). Findings that survive are high-confidence; refuted ones are
 * moved to a low-confidence bucket instead of being shown as real. Bounded and
 * cheap by construction: only P0/P1 (+ consensus), one round, no full diff.
 */

export function parseRefutation(stdout) {
  const doc = extractJsonObject(stdout);
  if (!doc || typeof doc.refuted !== "boolean") return null;
  return { refuted: Boolean(doc.refuted), reason: String(doc.reason ?? "").trim() };
}

function verifierFor(finding, options) {
  const skip = new Set([options.skipCodex ? "codex" : null, options.skipGrok ? "grok" : null].filter(Boolean));
  const raisedBy = new Set(finding.agents ?? []);
  // Prefer an agent that did not raise it (independent check); fall back to any
  // available non-claude agent (claude is the orchestrator here).
  for (const candidate of ["grok", "codex"]) {
    if (!skip.has(candidate) && !raisedBy.has(candidate)) return candidate;
  }
  for (const candidate of ["grok", "codex"]) {
    if (!skip.has(candidate)) return candidate;
  }
  return null;
}

function shouldVerify(finding, severities) {
  const allowed = new Set(severities ?? ["P0", "P1"]);
  return allowed.has(finding.severity) || finding.consensus;
}

async function runVerifier(agent, cwd, backends, options, prompt) {
  if (agent === "codex") return runCodexStructured(cwd, backends, options, prompt, "verify");
  return runGrokStructured(cwd, backends, options, prompt);
}

/**
 * Run the refutation pass and return { merged, refuted } where merged.all has a
 * `verified` annotation per checked finding, and refuted findings are moved out
 * of consensus/unique into a `refuted` list.
 */
export async function verifyFindings(cwd, backends, options, merged, buildEvidence, repoRoot) {
  const severities = options.verifySeverities ?? ["P0", "P1"];
  const verifyOpts = {
    ...options,
    maxTurns: options.maxTurnsR2,
    grokEffort: options.r2Effort ?? options.grokEffort
  };
  const targets = (merged.all ?? []).filter((f) => shouldVerify(f, severities));
  const jobs = targets.map(async (finding) => {
    const agent = verifierFor(finding, options);
    if (!agent) return { finding, verdict: null };
    const evidence = buildEvidence(repoRoot, [{ id: finding.ids?.[0], file: finding.file, line: finding.line }], "");
    const hadEvidence = Boolean(evidence) && evidence !== "(no file evidence available)";
    const prompt = interpolate(loadPrompt("r2-verify"), {
      AGENT: agent,
      FINDING_JSON: JSON.stringify(
        { id: finding.ids?.[0], severity: finding.severity, title: finding.title, detail: finding.detail, file: finding.file, line: finding.line },
        null,
        2
      ),
      NONCE: makeFenceNonce(),
      EVIDENCE: evidence
    });
    const res = await runVerifier(agent, cwd, backends, verifyOpts, prompt);
    // Trust a refutation only from a clean run (not skipped/timed-out/failed/empty).
    const trustworthy = !res.skipped && !res.timedOut && res.status === 0 && Boolean(String(res.stdout ?? "").trim());
    const verdict = trustworthy ? parseRefutation(res.stdout) : null;
    return { finding, agent, verdict, hadEvidence };
  });
  const results = await Promise.all(jobs);
  const refutedKeys = new Map();
  for (const r of results) {
    if (!r.verdict) continue;
    // Demote (hide a unique finding) only when the refutation is evidence-based;
    // default-refute with no evidence is unreliable, so annotate but keep it.
    refutedKeys.set(r.finding, {
      by: r.agent,
      refuted: r.verdict.refuted,
      reason: r.verdict.reason,
      demotable: r.hadEvidence
    });
  }
  return partitionByRefutation(merged, refutedKeys, targets.length);
}

/**
 * Split findings by refutation, protecting consensus. A consensus finding (>=2
 * agents raised it) is NEVER hidden by a single refuter - it stays in the main
 * list, annotated as disputed. Only single-agent findings that an independent
 * verifier could not support are moved to the low-confidence bucket. Pure and
 * testable; `refutations` maps finding -> {by, refuted, reason}.
 */
export function partitionByRefutation(merged, refutations, verifiedCount = 0) {
  const kept = [];
  const refuted = [];
  for (const f of merged.all ?? []) {
    const v = refutations.get(f);
    const annotated = v ? { ...f, verified: v } : f;
    // Demote only a refuted, single-agent finding whose refutation was
    // evidence-based (demotable !== false). Consensus stays (annotated disputed);
    // an evidence-less refutation annotates but never hides a finding.
    if (v?.refuted && v.demotable !== false && !f.consensus) refuted.push(annotated);
    else kept.push(annotated);
  }
  return {
    merged: {
      ...merged,
      all: kept,
      consensus: kept.filter((m) => m.consensus),
      unique: kept.filter((m) => !m.consensus),
      refuted
    },
    refutedCount: refuted.length,
    verifiedCount
  };
}
