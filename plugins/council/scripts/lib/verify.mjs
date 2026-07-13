import {
  interpolate,
  loadPrompt,
  makeFenceNonce,
  runCodexStructured,
  runGrokStructured
} from "./agents.mjs";
import { runClaudeStructured } from "./claude-agent.mjs";
import { runOpenRouterStructured } from "./openrouter-agent.mjs";
import { allSeatNames, isOpenRouterSeat, seatActive } from "./seats.mjs";
import { extractJsonObject } from "./findings.mjs";
import { skippedAgents } from "./policy.mjs";

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

// Cap concurrent verifier spawns. Unlike R1/R2 (2-4 jobs), verify scales with
// the finding count, so a large diff could otherwise fire dozens of CLI
// subprocesses at once and exhaust process/API limits.
const VERIFY_CONCURRENCY = 4;

/** Which verifier seats are actually reachable (probed), computed inline to avoid a cycle with
 *  audit-review's reviewerActive. Claude's cli is probed on the audit path (bare probeBackends). */
export function verifierAvailability(backends, options = {}) {
  return Object.fromEntries(allSeatNames(backends).map((s) => [s, seatActive(s, backends, options)]));
}

export function verifierFor(finding, options, available = null, backends = null) {
  // B2: Claude is now a first-class FINDER, so it must also be an eligible REFUTER — else a
  // codex-only P0 (grok skipped) ships UNVERIFIED even when Claude is a valid independent seat
  // (council codex-1). includeClaude:true so skipClaude drops it symmetrically.
  const skip = new Set(skippedAgents(options, { includeClaude: true }));
  const raisedBy = new Set(finding.agents ?? []);
  // ONLY an agent that did not raise the finding may verify it (a finding is never demoted by its
  // own author), and only one that is actually REACHABLE when availability is known — else we pick
  // a candidate whose spawn just fails, wasting a call and leaving the finding unverified anyway
  // (council claude-4). When `available` is null, availability is not gated (legacy callers).
  // An OpenRouter seat can also refute (it did NOT raise a built-in-authored finding) — so a finding
  // all three built-ins raised can still be independently checked. Built-ins first (cheapest), then OR.
  const candidates = ["grok", "codex", "claude", ...(backends?.openrouter?.seats ?? []).map((s) => s.id)];
  for (const candidate of candidates) {
    if (skip.has(candidate) || raisedBy.has(candidate)) continue;
    if (available && !available[candidate]) continue;
    return candidate;
  }
  return null;
}

export function shouldVerify(finding, severities) {
  const allowed = new Set(severities ?? ["P0", "P1"]);
  // Consensus findings are protected (partitionByRefutation never demotes them),
  // so verifying them is wasted spawns - only check demotable single-agent
  // findings of the target severities.
  return allowed.has(finding.severity) && !finding.consensus;
}

/** Run fn over items with at most `limit` in flight; preserves input order. */
async function mapWithLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  const workers = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workers }, worker));
  return results;
}

// Trust a refutation only from a clean, COMPLETE run (not skipped/timed-out/truncated/failed/
// empty). `truncated` can co-occur with status===0 (a maxBuffer-overflow kill can still report exit
// 0 if the process had already flushed output as/just-before the kill), so status===0 alone is not
// enough — mirrors textOf() in audit-patch-reviewer.mjs, which also excludes truncated. Exported as
// a pure predicate so this fail-closed decision is directly unit-testable without spawning a process.
export function isTrustworthyVerifierResult(res) {
  return !res.skipped && !res.timedOut && !res.truncated && res.status === 0 && Boolean(String(res.stdout ?? "").trim());
}

async function runVerifier(agent, cwd, backends, options, prompt) {
  if (agent === "codex") return runCodexStructured(cwd, backends, options, prompt, "verify");
  if (agent === "claude") return runClaudeStructured(cwd, backends, options, prompt);
  if (isOpenRouterSeat(agent, backends)) return runOpenRouterStructured(cwd, backends, options, prompt, agent);
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
  const budget = options.budget ?? null;
  const available = verifierAvailability(backends, options); // B2: only pick a reachable, non-authoring seat
  const targets = (merged.all ?? []).filter((f) => shouldVerify(f, severities));
  const results = await mapWithLimit(targets, options.verifyConcurrency ?? VERIFY_CONCURRENCY, async (finding) => {
    const agent = verifierFor(finding, options, available, backends);
    if (!agent) return { finding, verdict: null };
    // Charge the finite invocation budget so refutation spend is ACCOUNTED (it used to fan
    // out uncounted). Reserve BEFORE the await; if the budget can't afford it, skip this
    // refutation and KEEP the finding (a budget-starved verify must never drop a finding).
    if (budget) {
      if (!budget.canSpend(1)) return { finding, verdict: null };
      budget.charge(1);
    }
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
    const trustworthy = isTrustworthyVerifierResult(res);
    const verdict = trustworthy ? parseRefutation(res.stdout) : null;
    return { finding, agent, verdict, hadEvidence };
  });
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
  return partitionByRefutation(merged, refutedKeys, targets.length, { demote: options.demote !== false });
}

/**
 * Split findings by refutation, protecting consensus. A consensus finding (>=2
 * agents raised it) is NEVER hidden by a single refuter - it stays in the main
 * list, annotated as disputed. Only single-agent findings that an independent
 * verifier could not support are moved to the low-confidence bucket. Pure and
 * testable; `refutations` maps finding -> {by, refuted, reason}.
 */
export function partitionByRefutation(merged, refutations, verifiedCount = 0, { demote = true } = {}) {
  const kept = [];
  const refuted = [];
  for (const f of merged.all ?? []) {
    const v = refutations.get(f);
    const annotated = v ? { ...f, verified: v } : f;
    // A refuted, single-agent, evidence-based finding (demotable !== false) is a refutation
    // candidate. Consensus is never a candidate (protected).
    const isRefuted = Boolean(v?.refuted && v.demotable !== false && !f.consensus);
    if (isRefuted) refuted.push(annotated);
    // demote:true HIDES refuted candidates from `.all` (deliberate path, human-reviewed).
    // demote:false (ANNOTATE-ONLY) keeps them VISIBLE in `.all` with their `verified`
    // annotation — so on the autonomous audit path a wrongly-refuted REAL finding is never
    // silently dropped; downstream only DEPRIORITIZES it (propose-only), never erases it.
    if (!isRefuted || !demote) kept.push(annotated);
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
