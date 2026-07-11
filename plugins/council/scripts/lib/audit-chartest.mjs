// Firewalled characterization-test acceptance + mutation gate (docs/enterprise-fix-
// design.md §5). The test GENERATOR runs in its own invocation, structurally firewalled
// from the fix writer (audit-fix's enforceTouched already forbids the fixer from
// touching test files, in either direction). This lib is the ACCEPTANCE GATE: a
// generated characterization test may gate a refactor ONLY if it
//   (a) passes on the UNMODIFIED code — it pins REAL observed behaviour (execute-and-
//       capture), not an LLM's guess about what the code should do;
//   (b) is bit-identical across N runs — deterministic; a target that varies (time /
//       random / IO / ordering) is un-pinnable and routes to propose-only;
//   (c) actually executes the target symbol — a test that never runs the code proves
//       nothing.
// Pure control flow; the run/execute/mutation checks are injectable so this is testable
// without a repo, an agent, or a test runner.

/**
 * Decide whether a generated characterization test may gate a refactor.
 * deps: { passesOnUnmodified()->bool, runs(n)->string[] (captured output per run),
 *         executesTarget()->bool }. Returns { accept, reason }.
 */
export async function acceptCharTest(deps = {}, { reruns = 3 } = {}) {
  const { passesOnUnmodified, runs, executesTarget } = deps;
  if (typeof passesOnUnmodified !== "function" || typeof runs !== "function" || typeof executesTarget !== "function") {
    return { accept: false, reason: "characterization-test harness incomplete (missing passesOnUnmodified/runs/executesTarget)" };
  }
  const n = Math.max(2, Math.floor(reruns));
  if (!(await passesOnUnmodified())) {
    return { accept: false, reason: "generated test does not pass on the unmodified code — it pins a guess, not observed behaviour" };
  }
  const outputs = await runs(n);
  if (!Array.isArray(outputs) || outputs.length < n) {
    return { accept: false, reason: "could not establish determinism (too few runs captured)" };
  }
  const first = outputs[0];
  if (!outputs.every((o) => o === first)) {
    return { accept: false, reason: "non-deterministic target — captured output differs across runs; route to propose-only" };
  }
  if (!(await executesTarget())) {
    return { accept: false, reason: "generated test does not execute the target symbol" };
  }
  return { accept: true, reason: "characterization test pins deterministic observed behaviour of the target" };
}

/**
 * Mutation-adequacy gate: the test net must KILL a sufficient fraction of mutants in the
 * touched region (and its immediate callers) to be non-vacuous — a green suite with a
 * weak net proves little. deps.mutationScore({ file, lines })->0..1 is injectable.
 */
export async function mutationGate(deps = {}, { threshold = 0.6, file, lines } = {}) {
  const { mutationScore } = deps;
  if (typeof mutationScore !== "function") return { pass: false, reason: "mutation harness unavailable" };
  let score = 0;
  try {
    score = Number(await mutationScore({ file, lines }));
  } catch (err) {
    return { pass: false, reason: `mutation run failed: ${String(err?.message ?? err)}` };
  }
  if (!Number.isFinite(score)) return { pass: false, reason: "mutation score unavailable" };
  return score >= threshold
    ? { pass: true, score, reason: `mutation score ${score.toFixed(2)} >= ${threshold}` }
    : { pass: false, score, reason: `mutation score ${score.toFixed(2)} < ${threshold} — the test net is too weak to trust` };
}
