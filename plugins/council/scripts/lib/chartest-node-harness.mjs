// Node / node:test execute-and-capture HARNESS for the §5 char-test gate (chartest-gate.mjs). Supplies
// the acceptCharTest deps (passesOnUnmodified / runs / executesTarget / perturbedRun) by shelling out to
// `node --test` and reading V8 coverage. The harness runs the test against the CURRENT working tree, so
// the CALLER sequences it: accept BEFORE applying the refactor (tree = original), verify AFTER.
//
// The generator is prompted to console.log(JSON.stringify(observable)); captureObservable isolates those
// JSON lines from the TAP/timing noise so DETERMINISM reflects the OBSERVABLE, not the runner's varying
// duration_ms. Pure helpers (captureObservable, changedLinesCovered) are exported + unit-tested; the
// subprocess/fs orchestration is injected (runCommand/readCoverage) so it stays testable and fail-closed.
import path from "node:path";
import { fileURLToPath } from "node:url";

// Normalize a coverage script URL / a path to a comparable absolute form. Uses fileURLToPath so a
// percent-encoded file:// URL (e.g. a repo path with a space → %20) DECODES to the real path (council
// Codex/Claude P2 — otherwise the target is never found and every refactor silently fails closed). On
// win32 the compare is case-insensitive (V8 `/c:/…` vs a `C:\…` cwd).
function normPath(u) {
  let p = String(u ?? "");
  try {
    if (p.startsWith("file:")) p = fileURLToPath(p);
  } catch {
    /* fall through with the raw string */
  }
  try {
    p = path.resolve(p);
  } catch {
    /* keep p */
  }
  return process.platform === "win32" ? p.toLowerCase() : p;
}

/**
 * Isolate the characterization OBSERVABLE from a `node --test` run's stdout: the lines the test printed
 * via console.log(JSON.stringify(...)). TAP status lines, `#` comments (which carry the volatile
 * duration_ms), and blanks are dropped, so two runs of a DETERMINISTIC target yield an identical capture
 * while runner timing does not. Returns the joined JSON observable lines ("" if the test printed none →
 * acceptCharTest then rejects it as vacuous).
 */
export function captureObservable(stdout) {
  const out = [];
  for (const raw of String(stdout ?? "").split(/\r?\n/)) {
    const t = raw.trim();
    if (!t) continue;
    if (t.startsWith("#") || t === "TAP version 13" || /^(ok|not ok)\b/.test(t) || /^\d+\.\.\d+$/.test(t)) continue;
    try {
      JSON.parse(t);
      out.push(t); // a bare JSON value line = an emitted observable
    } catch {
      /* not an observable line (TAP framing / prose) — ignore */
    }
  }
  return out.join("\n");
}

/** 0-based line index → the character OFFSET at which that line starts, for `source`. */
function lineStartOffsets(source) {
  const starts = [0];
  for (let i = 0; i < source.length; i += 1) if (source[i] === "\n") starts.push(i + 1);
  return starts;
}

/**
 * Check that the test EXECUTED the target's changed lines, from a V8 coverage document (NODE_V8_COVERAGE),
 * with INNERMOST-RANGE-WINS semantics (council Codex/Claude P1): V8 ranges are NESTED — a called function's
 * outer range has count>0 and spans its whole body, while count:0 sub-ranges carve out its never-taken
 * branches. Unioning only count>0 ranges wrongly marks a changed line inside an unexecuted branch covered
 * (→ a behaviour change there false-greens). So for each changed line we find the SMALLEST range that
 * contains its start offset and honour THAT range's count. Fail-CLOSED: target absent, empty changedLines,
 * or any changed line whose innermost range is count:0 (or uncovered) → false.
 */
export function changedLinesCovered(coverageDoc, absTargetPath, source, changedLines) {
  const changed = (Array.isArray(changedLines) ? changedLines : []).filter((n) => Number.isFinite(n));
  if (changed.length === 0) return false;
  const target = normPath(absTargetPath);
  const script = (coverageDoc?.result ?? []).find((r) => normPath(String(r.url ?? "")) === target);
  if (!script) return false;
  const ranges = [];
  for (const fn of script.functions ?? []) for (const rg of fn.ranges ?? []) {
    if (Number.isFinite(rg.startOffset) && Number.isFinite(rg.endOffset)) ranges.push(rg);
  }
  if (ranges.length === 0) return false;
  const starts = lineStartOffsets(String(source ?? ""));
  const covered = (line) => {
    const off = starts[line - 1];
    if (off == null) return false;
    let best = null; // the innermost (smallest-width) range containing this offset
    for (const rg of ranges) {
      if (off < rg.startOffset || off >= rg.endOffset) continue;
      if (!best || rg.endOffset - rg.startOffset < best.endOffset - best.startOffset) best = rg;
    }
    return best != null && (best.count ?? 0) > 0;
  };
  return changed.every(covered);
}

/**
 * Build the acceptCharTest harness for a Node target. `deps`:
 *   - runCommand(cmd, args, { cwd, env, timeoutMs }) -> { status, stdout, timedOut }   (injected exec)
 *   - readCoverage(dir) -> coverageDoc|null   (merge/read the NODE_V8_COVERAGE json in dir; injected fs)
 *   - source   (the target's CURRENT source text, for offset→line mapping in the coverage check)
 * A run's timeout / non-zero exit / capture fault fails the specific check closed (no throw escapes).
 */
export function makeNodeCharHarness({ cwd, testFile, targetFile, changedLines = [], source = "", runCommand, readCoverage, coverageDir, timeoutMs = 60_000, sandboxArgs } = {}) {
  // SANDBOX the model-generated test (council Grok P0 — RCE): the test body is written by a seat that saw
  // untrusted target source, then executed by `node --test`. Node's permission model
  // (--experimental-permission) DENIES child_process (no shell/spawn/curl) and fs WRITES by default — the
  // two vectors a prompt-injected test would use to tamper or persist. fs READS are allowed (the test must
  // import the target; source read-exfil is no worse than the audit already sending source to the model
  // seats). A node too old to support the flag simply errors → the run fails → fail-CLOSED (propose-only).
  // Overridable via sandboxArgs (tests pass []); the coverage run additionally allows writing its dir.
  const baseSandbox = Array.isArray(sandboxArgs) ? sandboxArgs : ["--experimental-permission", "--allow-fs-read=*"];
  const runOnce = async (extraEnv = {}, extraArgs = []) => {
    const res = await runCommand("node", [...baseSandbox, ...extraArgs, "--test", testFile], { cwd, env: { ...process.env, ...extraEnv }, timeoutMs });
    return res ?? { status: 1, stdout: "", timedOut: false };
  };
  return {
    passesOnUnmodified: async () => {
      const r = await runOnce();
      return !r.timedOut && r.status === 0;
    },
    runs: async (n) => {
      const outs = [];
      for (let i = 0; i < n; i += 1) {
        const r = await runOnce();
        if (r.timedOut || r.status !== 0) return outs; // a failed/timed-out repeat → short list → acceptCharTest rejects
        outs.push(captureObservable(r.stdout));
      }
      return outs;
    },
    perturbedRun: async () => {
      // Vary LOCALE + TIMEZONE so a hidden TZ/locale dependence the same-process repeat can't see
      // surfaces. NOTE (council nit): this does NOT seed the RNG or fake the wall clock — Math.random()
      // and Date.now() dependence are instead caught by the N-run DETERMINISM check (they differ across
      // separate-process repeats). So the guarantee is "locale/TZ-perturbed + cross-run deterministic",
      // not a fixed-seed harness.
      const r = await runOnce({ TZ: "Pacific/Kiritimati", LANG: "de_DE.UTF-8", LC_ALL: "de_DE.UTF-8" });
      if (r.timedOut || r.status !== 0) return null; // differs from a captured string → acceptCharTest rejects
      return captureObservable(r.stdout);
    },
    executesTarget: async () => {
      if (typeof readCoverage !== "function" || !coverageDir) return false; // can't verify → fail closed
      // the coverage run must be allowed to WRITE its NODE_V8_COVERAGE dir under the sandbox
      const r = await runOnce({ NODE_V8_COVERAGE: coverageDir }, [`--allow-fs-write=${coverageDir}`]);
      if (!r || r.timedOut || r.status !== 0) return false;
      const doc = readCoverage(coverageDir);
      if (!doc) return false;
      return changedLinesCovered(doc, path.isAbsolute(targetFile) ? targetFile : path.join(cwd, targetFile), source, changedLines);
    },
    // ACCEPT-phase coverage check (council Grok P1): the test must actually EXECUTE the target module —
    // ≥1 of the target's functions ran (count>0) — not merely import it unused with a tautology. Weaker
    // than the changed-line bar (the diff is unknown pre-apply) but it forecloses "imports target, asserts
    // 1===1". Fail-closed: no coverage reader / target absent / no executed function → false.
    executesModule: async () => {
      if (typeof readCoverage !== "function" || !coverageDir) return false;
      const r = await runOnce({ NODE_V8_COVERAGE: coverageDir }, [`--allow-fs-write=${coverageDir}`]);
      if (!r || r.timedOut || r.status !== 0) return false;
      const doc = readCoverage(coverageDir);
      const abs = path.isAbsolute(targetFile) ? targetFile : path.join(cwd, targetFile);
      const script = (doc?.result ?? []).find((s) => normPath(String(s.url ?? "")) === normPath(abs));
      if (!script) return false;
      // ≥1 target function actually ran (a count>0 range that is NOT the whole-script outer wrapper) —
      // "imported unused" leaves only the outer count and count:0 function bodies.
      return (script.functions ?? []).some((fn) => (fn.ranges ?? []).some((rg) => (rg.count ?? 0) > 0));
    }
  };
}
