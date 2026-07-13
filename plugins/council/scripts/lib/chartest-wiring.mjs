// Wiring for the §5 char-test gate: composes the firewalled GENERATOR (a model seat) + the Node/node:test
// HARNESS (real `node --test` + poison-probe/coverage dependence checks) + the acceptance/verify state
// machine (chartest-gate.mjs) into the `charTestGate` object runAuditFix consumes. Opt-in (--chartest);
// absent → the fix path is byte-identical. Every side effect (generate seat / exec / fs) is injected so
// this is unit-testable without a CLI or a real test run, and fail-CLOSED (any fault → not accepted /
// not verified → propose-only; a failed poison-probe restore is FATAL and thrown, never swallowed).
import fs from "node:fs";
import path from "node:path";

import { acceptCharTestForTarget, isRefactorClass, verifyCharTestAfterFix } from "./chartest-gate.mjs";
import { makeNodeCharHarness } from "./chartest-node-harness.mjs";
import { activeSeatNames, makeSeatRunners } from "./seats.mjs";
import { runCommandAsync } from "./process.mjs";

// The transient test file lives BESIDE the target (so a "./basename" import resolves) with a clear,
// council-owned, dotfile name — created, run, and DELETED within each phase, never committed. Two guards:
//  - the derived base STRIPS any .test/.spec marker AND the extension, so the name can NEVER match node's
//    default `**/*.test.?(c|m)js` discovery even when the TARGET is itself a test file (council Claude P2);
//  - a UNIQUIFIER + existence check picks a free `.i` slot, so we never overwrite/delete a pre-existing
//    (gitignored) file of the same name — git rollback can't restore ignored data (council Codex P2).
function transientTestPath(root, file, exists) {
  const abs = path.join(root, file);
  const dir = path.dirname(abs);
  const base = path.basename(abs).replace(/\.[cm]?[jt]sx?$/i, "").replace(/[._-](test|spec)$/i, "") || "target";
  for (let i = 0; i < 1000; i += 1) {
    const p = path.join(dir, `.council-chartest-${i}.${base}.mjs`);
    if (!exists(p)) return p;
  }
  return null; // 1000 collisions is absurd → caller fails closed (propose-only)
}

/**
 * Build the charTestGate for runAuditFix. `deps` (all injectable for tests):
 *   - generate(prompt) -> stdout        (firewalled seat; default = first active seat via makeSeatRunners)
 *   - runCommand(cmd,args,opts)         (default runCommandAsync)
 *   - writeFile(p, s) / removeFile(p) / readFile(p)   (default node:fs)
 *   - readCoverage(dir) -> coverageDoc  (merge NODE_V8_COVERAGE json; default reads + merges dir)
 *   - mkCoverageDir() -> dir            (a fresh coverage dir; default a sibling temp under the target dir)
 * Returns null when no seat can generate (so the CLI can warn instead of enabling a gate that always
 * fail-closes every refactor to propose-only).
 */
export function makeCharTestGate(cwd, backends, options = {}, deps = {}) {
  const root = cwd;
  const runCommand = deps.runCommand ?? runCommandAsync;
  const writeFile = deps.writeFile ?? ((p, s) => fs.writeFileSync(p, s, "utf8"));
  const readFile = deps.readFile ?? ((p) => fs.readFileSync(p, "utf8"));
  const removeFile = deps.removeFile ?? ((p) => { try { fs.rmSync(p, { force: true }); } catch { /* best effort */ } });
  const readCoverage = deps.readCoverage ?? defaultReadCoverage;
  const mkCoverageDir = deps.mkCoverageDir ?? ((testFile) => path.join(path.dirname(testFile), `.council-chartest-cov-${path.basename(testFile)}`));
  // freshDir returns an EMPTY dir (rm then mkdir) so a prior run's coverage json can never be merged into
  // this run's executesChanged check (council Grok P2 — stale coverage false-pass); rmDir tears it down.
  const freshDir = deps.freshDir ?? ((d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* */ } try { fs.mkdirSync(d, { recursive: true }); } catch { /* */ } return d; });
  const rmDir = deps.rmDir ?? ((d) => { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } });
  const exists = deps.exists ?? ((p) => fs.existsSync(p));
  const timeoutMs = Number(options.charTestTimeoutMs) || 60_000;

  // The generator seat: the first ACTIVE seat (availability + skips honoured), model-agnostic — the critic
  // writes a test, not code. Returns a generate(prompt)->stdout, or NULL when no seat is active (council
  // Codex/Claude P2: the old Object.keys(runners)[0] was ALWAYS 'codex' regardless of availability, so a
  // --skip-codex / codex-down run silently produced empty tests + a dead null-return path). resolveCharTestGate
  // then fails loud on null rather than running the gate silently disabled.
  const generate = deps.generate ?? (() => {
    const active = activeSeatNames(backends, options);
    if (!active.length) return null;
    const runners = makeSeatRunners(cwd, backends, options);
    const seat = active.find((s) => typeof runners[s] === "function");
    if (!seat) return null;
    return (prompt) => runners[seat](prompt).then((r) => (r && !r.skipped && r.status === 0 ? String(r.stdout ?? "") : ""));
  })();
  if (typeof generate !== "function") return null;

  const importPathFor = (file) => `./${path.basename(file)}`;

  // A poison-probe RESTORE failure must never be silent (§5 fail-closed, hardest case): the harness has
  // already retried and thrown; here we try one last rewrite from the in-memory source snapshot, then
  // throw LOUDLY either way — a result computed over a possibly-poisoned tree must never be returned as
  // if it were a mere probe verdict.
  const guardPoisonRestore = (harness, absTarget, sourceSnapshot) => {
    if (!harness?.restoreFailure) return;
    let recovered = false;
    try {
      writeFile(absTarget, sourceSnapshot);
      recovered = readFile(absTarget) === sourceSnapshot;
    } catch { /* recovery failed — reported below */ }
    // Tag the error so the fix loop can tell a corrupted-tree FATAL apart from an ordinary accept
    // failure (which is merely propose-only). A poisoned target left on disk MUST abort the run, not
    // silently continue leaking the poison into every subsequent fix/review. `recovered` records
    // whether the in-memory snapshot restored the file (still abort — the tree needs verification).
    const err = new Error(`FATAL §5 char-test: poison-probe restore failed for ${absTarget} (${String(harness.restoreFailure?.message ?? harness.restoreFailure)})${recovered ? " — the target was recovered from the in-memory snapshot; verify the tree before trusting later results" : " — the target MAY STILL BE POISONED on disk; restore it from VCS before continuing"}`);
    err.fatalPoison = true;
    err.poisonRecovered = recovered;
    throw err;
  };
  // Surface the harness's probe notes — the HONEST cause ("the test does not depend on the target" vs
  // "changed-line coverage unavailable under the sandbox") — in the reason the caller logs/records, so a
  // platform limitation is never misreported as a defect of the generated test (council Codex/Claude P1).
  const withNotes = (reason, harness) => {
    const ns = Array.isArray(harness?.notes) ? harness.notes : [];
    return ns.length ? `${reason ?? ""} [${ns.join("; ")}]`.trim() : reason;
  };

  return {
    eligible: (finding) => isRefactorClass(finding),

    // ACCEPT (clean tree): generate + pin behaviour (deterministic, non-vacuous) AND require the test to
    // actually DEPEND on the target (council Grok P1 — no "import unused + assert 1===1"): acceptCharTest's
    // executesTarget maps to the harness's poison-probe executesModule here (the exact changed-line bar is
    // DEFERRED to verify — the diff is unknown pre-apply). The transient test + coverage dir are deleted
    // before returning so the tree is clean for applyFix.
    accept: async ({ file, source }) => {
      const testFile = transientTestPath(root, file, exists);
      if (!testFile) return { accepted: false, reason: "could not allocate a transient char-test path (collisions) → propose-only" };
      const coverageDir = freshDir(mkCoverageDir(testFile));
      const h = makeNodeCharHarness({ cwd: root, testFile, targetFile: file, source, runCommand, readCoverage, coverageDir, timeoutMs, readFile, writeFile });
      const acceptHarness = { ...h, executesTarget: h.executesModule };
      let res;
      try {
        res = await acceptCharTestForTarget(file, source, {
          generate,
          writeTest: (code) => { writeFile(testFile, code); return testFile; },
          harness: acceptHarness,
          reruns: options.charTestReruns,
          promptOptions: { importPath: importPathFor(file) }
        });
      } finally {
        removeFile(testFile);
        rmDir(coverageDir);
        guardPoisonRestore(h, path.join(root, file), source); // fatal + loud — never a silent poisoned tree
      }
      // carry the generated code + the baseline observable forward so verify can re-materialise the SAME
      // test post-apply and compare the observable (the load-bearing behaviour-preservation check)
      return { accepted: res.accepted, reason: withNotes(res.reason, h), code: res.code, baseline: res.baseline, testFile };
    },

    // VERIFY (post-apply tree): re-materialise the accepted test, require it STILL passes AND — for an
    // addition/modification — exercises the changed region (real changed-line coverage where the platform
    // permits it; the poison probe, honestly disclosed via notes, under the default sandbox), then delete
    // it. A pure DELETION has no new lines to cover (council Grok P2: dead_code deletions), so the
    // changed-line bar is skipped there; the still-green check alone attests behaviour preservation.
    // Mutation gate stays OPTIONAL.
    verify: async ({ file, source, code, baseline, changedLines }) => {
      if (!code) return { pass: false, reason: "no accepted char-test to verify" };
      const testFile = transientTestPath(root, file, exists);
      if (!testFile) return { pass: false, reason: "could not allocate a transient char-test path (collisions) → propose-only" };
      writeFile(testFile, code);
      const coverageDir = freshDir(mkCoverageDir(testFile));
      const harness = makeNodeCharHarness({ cwd: root, testFile, targetFile: file, changedLines, source, runCommand, readCoverage, coverageDir, timeoutMs, readFile, writeFile });
      const hasNewLines = Array.isArray(changedLines) && changedLines.length > 0;
      let out;
      try {
        out = await verifyCharTestAfterFix({ accepted: true, testPath: testFile, baseline }, {
          runAccepted: harness.passesOnUnmodified, // "passes on the CURRENT (post-refactor) tree" = behaviour preserved
          // the LOAD-BEARING check: the observable must match the accepted baseline (harness = oracle)
          observe: async () => { const o = await harness.runs(1); return Array.isArray(o) && o.length ? o[0] : null; },
          // only require changed-line coverage when the refactor ADDED/MODIFIED lines; a pure deletion has none
          executesChanged: hasNewLines ? harness.executesTarget : undefined
        });
      } finally {
        removeFile(testFile);
        rmDir(coverageDir);
        guardPoisonRestore(harness, path.join(root, file), source); // fatal + loud — never a silent poisoned tree
      }
      return { ...out, reason: withNotes(out.reason, harness) };
    }
  };
}

/** Read + merge the coverage-*.json files a NODE_V8_COVERAGE run wrote into `dir` → { result:[...] }. */
function defaultReadCoverage(dir) {
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return null;
  }
  const result = [];
  for (const f of files) {
    try {
      const doc = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      if (Array.isArray(doc.result)) result.push(...doc.result);
    } catch {
      /* skip an unreadable/partial coverage file */
    }
  }
  return result.length ? { result } : null;
}
