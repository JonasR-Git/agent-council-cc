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
    const prompt = interpolate(loadPrompt("r2-verify"), {
      AGENT: agent,
      FINDING_JSON: JSON.stringify(
        { id: finding.ids?.[0], severity: finding.severity, title: finding.title, detail: finding.detail, file: finding.file, line: finding.line },
        null,
        2
      ),
      NONCE: makeFenceNonce(),
      EVIDENCE: buildEvidence(repoRoot, [{ id: finding.ids?.[0], file: finding.file, line: finding.line }], "")
    });
    const res = await runVerifier(agent, cwd, backends, verifyOpts, prompt);
    return { finding, agent, verdict: res.skipped ? null : parseRefutation(res.stdout) };
  });
  const results = await Promise.all(jobs);

  const refutedKeys = new Map();
  for (const r of results) {
    if (!r.verdict) continue;
    refutedKeys.set(r.finding, { by: r.agent, refuted: r.verdict.refuted, reason: r.verdict.reason });
  }

  const kept = [];
  const refuted = [];
  for (const f of merged.all ?? []) {
    const v = refutedKeys.get(f);
    const annotated = v ? { ...f, verified: v } : f;
    if (v?.refuted) refuted.push(annotated);
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
    verifiedCount: targets.length
  };
}
