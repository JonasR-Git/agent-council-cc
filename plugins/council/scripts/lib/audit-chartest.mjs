// Firewalled characterization-test acceptance + mutation gate (docs/enterprise-fix-
// design.md §5). The test GENERATOR runs in its OWN invocation, structurally firewalled
// from the fix writer: it is prompted with ONLY the target source (never the finding /
// fix diff), it commits BEFORE the fix invocation starts, and a multi-file-aware
// enforce (the test file + any VCR fixture files, never the production target) authorizes
// its writes. audit-fix's enforceTouched already forbids the fix writer from touching
// test files in either direction. This lib is the ACCEPTANCE GATE: a generated
// characterization test may gate a refactor ONLY if it
//   (a) passes on the UNMODIFIED code — execute-and-capture pins REAL observed behaviour,
//       not an LLM guess, and it captures a NON-EMPTY observable (anti-vacuity: a test
//       that asserts nothing is rejected);
//   (b) is bit-identical across N runs AND (when a perturbed run is supplied) under a
//       faked clock/locale/seed — a same-process repeat alone can't see TZ/locale/random
//       dependence, so an environment-varied run is required to firewall the time/IO
//       class the header claims to catch;
//   (c) executes the target's CHANGED LINES (anchored to coverage of the diff, not merely
//       "the file loaded").
// Pure control flow; every check is injectable + fail-closed on a harness fault.
//
// STATUS: WIRED (opt-in --chartest). chartest-gate.mjs composes this acceptance gate with a firewalled
// GENERATOR + the Node/node:test harness (chartest-node-harness.mjs), chartest-wiring.mjs builds the
// live charTestGate, and runAuditFix runs it around a behaviour-preserving refactor: ACCEPT on the clean
// tree (pin behaviour), then VERIFY the pinned test stays green + covers the changed lines after the
// refactor. mutationGate stays OPTIONAL (only when a scorer is configured). Default OFF → path unchanged.

/**
 * Decide whether a generated characterization test may gate a refactor.
 * deps: { passesOnUnmodified()->bool, runs(n)->string[] (captured output per run),
 *         executesTarget()->bool, perturbedRun?()->string (output under a faked
 *         clock/locale/seed) }. Returns { accept, reason }.
 */
export async function acceptCharTest(deps = {}, { reruns = 3 } = {}) {
  const { passesOnUnmodified, runs, executesTarget, perturbedRun } = deps;
  if (typeof passesOnUnmodified !== "function" || typeof runs !== "function" || typeof executesTarget !== "function") {
    return { accept: false, reason: "characterization-test harness incomplete (missing passesOnUnmodified/runs/executesTarget)" };
  }
  const n = Number.isFinite(reruns) ? Math.max(2, Math.floor(reruns)) : 3;
  try {
    if (!(await passesOnUnmodified())) {
      return { accept: false, reason: "generated test does not pass on the unmodified code — it pins a guess, not observed behaviour" };
    }
    const outputs = await runs(n);
    if (!Array.isArray(outputs) || outputs.length < n) {
      return { accept: false, reason: "could not establish determinism (too few runs captured)" };
    }
    const first = outputs[0];
    if (first == null || String(first).trim() === "") {
      return { accept: false, reason: "vacuous test — captured no observable output (asserts nothing meaningful)" };
    }
    if (!outputs.every((o) => o === first)) {
      return { accept: false, reason: "non-deterministic target — captured output differs across runs; route to propose-only" };
    }
    if (typeof perturbedRun === "function") {
      const p = await perturbedRun();
      if (p !== first) {
        return { accept: false, reason: "environment-dependent target — output changes under a perturbed clock/locale/seed; route to propose-only" };
      }
    }
    if (!(await executesTarget())) {
      return { accept: false, reason: "generated test does not execute the target's changed lines" };
    }
    return { accept: true, reason: "characterization test pins deterministic, observed behaviour of the target's changed lines" };
  } catch (err) {
    return { accept: false, reason: `char-test harness fault: ${String(err?.message ?? err)}` };
  }
}

// Severity-aware mutation thresholds (§5: mandatory + a higher bar for P0/P1).
const SEV_THRESHOLD = { P0: 0.8, P1: 0.7 };

/**
 * Mutation-adequacy gate: the test net must KILL a sufficient fraction of mutants in the
 * changed lines AND their immediate callers (a 100% score on the diff with untested
 * affected callers is a false green — §5). deps.mutationScore({ file, lines, callers })
 * -> 0..1 is injectable and scores the union; the threshold rises for P0/P1.
 */
export async function mutationGate(deps = {}, { threshold, file, lines, callers = [], severity } = {}) {
  const { mutationScore } = deps;
  if (typeof mutationScore !== "function") return { pass: false, reason: "mutation harness unavailable" };
  const bar = Number.isFinite(threshold) ? threshold : SEV_THRESHOLD[severity] ?? 0.6;
  let score;
  try {
    score = Number(await mutationScore({ file, lines, callers }));
  } catch (err) {
    return { pass: false, reason: `mutation run failed: ${String(err?.message ?? err)}` };
  }
  if (!Number.isFinite(score) || score < 0 || score > 1) return { pass: false, reason: "mutation score out of range [0,1]" };
  return score >= bar
    ? { pass: true, score, threshold: bar, reason: `mutation score ${score.toFixed(2)} >= ${bar} (changed lines + callers)` }
    : { pass: false, score, threshold: bar, reason: `mutation score ${score.toFixed(2)} < ${bar} — the test net is too weak to trust` };
}
