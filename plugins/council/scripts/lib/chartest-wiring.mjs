// Wiring for the §5 char-test gate: composes the firewalled GENERATOR (a model seat) + the Node/node:test
// HARNESS (real `node --test` + V8 coverage) + the acceptance/verify state machine (chartest-gate.mjs)
// into the `charTestGate` object runAuditFix consumes. Opt-in (--chartest); absent → the fix path is
// byte-identical. Every side effect (generate seat / exec / fs) is injected so this is unit-testable
// without a CLI or a real test run, and fail-CLOSED (any fault → not accepted / not verified → propose-only).
import fs from "node:fs";
import path from "node:path";

import { acceptCharTestForTarget, isRefactorClass, verifyCharTestAfterFix } from "./chartest-gate.mjs";
import { makeNodeCharHarness } from "./chartest-node-harness.mjs";
import { makeSeatRunners } from "./seats.mjs";
import { runCommandAsync } from "./process.mjs";

// The transient test file lives BESIDE the target (so a "./basename" import resolves) with a clear,
// council-owned, dotfile name — it is created, run, and DELETED within each phase, never committed. The
// dot prefix + `node --test <specific file>` (not a glob) keep it out of the user's own test discovery.
function transientTestPath(root, file) {
  const abs = path.join(root, file);
  const dir = path.dirname(abs);
  const base = path.basename(abs).replace(/\.[cm]?[jt]sx?$/i, "");
  return path.join(dir, `.council-chartest.${base}.mjs`);
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
  const removeFile = deps.removeFile ?? ((p) => { try { fs.rmSync(p, { force: true }); } catch { /* best effort */ } });
  const readCoverage = deps.readCoverage ?? defaultReadCoverage;
  const mkCoverageDir = deps.mkCoverageDir ?? ((testFile) => path.join(path.dirname(testFile), `.council-chartest-cov-${path.basename(testFile)}`));
  const timeoutMs = Number(options.charTestTimeoutMs) || 60_000;

  // The generator seat: default to the first active seat (model-agnostic — the critic writes a test, not
  // code). Returns a generate(prompt)->stdout, or null when no seat is reachable.
  const generate = deps.generate ?? (() => {
    const runners = makeSeatRunners(cwd, backends, options);
    const first = Object.keys(runners)[0];
    if (!first) return null;
    return (prompt) => runners[first](prompt).then((r) => (r && !r.skipped && r.status === 0 ? String(r.stdout ?? "") : ""));
  })();
  if (typeof generate !== "function") return null;

  const importPathFor = (file) => `./${path.basename(file)}`;

  return {
    eligible: (finding) => isRefactorClass(finding),

    // ACCEPT (clean tree): generate + pin behaviour (deterministic, non-vacuous). executesTarget is
    // DEFERRED to verify (the changed lines are only known post-apply), so the accept harness stubs it
    // true. The transient test file is deleted before returning so the tree is clean for applyFix.
    accept: async ({ file, source }) => {
      const testFile = transientTestPath(root, file);
      const acceptHarness = {
        ...makeNodeCharHarness({ cwd: root, testFile, targetFile: file, source, runCommand, timeoutMs }),
        executesTarget: async () => true // deferred to the verify phase (changed lines unknown pre-apply)
      };
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
      }
      // carry the generated code forward so verify can re-materialise the SAME test post-apply
      return { accepted: res.accepted, reason: res.reason, code: res.code, testFile };
    },

    // VERIFY (post-apply tree): re-materialise the accepted test, require it STILL passes AND covers the
    // changed lines, then delete it. The mutation gate stays OPTIONAL (only when a scorer is configured).
    verify: async ({ file, source, code, changedLines }) => {
      const testFile = transientTestPath(root, file);
      if (!code) return { pass: false, reason: "no accepted char-test to verify" };
      writeFile(testFile, code);
      const coverageDir = mkCoverageDir(testFile);
      const harness = makeNodeCharHarness({ cwd: root, testFile, targetFile: file, changedLines, source, runCommand, readCoverage, coverageDir, timeoutMs });
      try {
        return await verifyCharTestAfterFix({ accepted: true, testPath: testFile }, {
          runAccepted: harness.passesOnUnmodified, // "passes on the CURRENT (post-refactor) tree" = behaviour preserved
          executesChanged: harness.executesTarget
        });
      } finally {
        removeFile(testFile);
        try { fs.rmSync(coverageDir, { recursive: true, force: true }); } catch { /* best effort */ }
      }
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
