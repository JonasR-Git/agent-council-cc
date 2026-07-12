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

/** Convert a character OFFSET in `source` to a 1-based line number (for V8 range → line mapping). */
function offsetToLine(source, offset) {
  let line = 1;
  const end = Math.min(offset, source.length);
  for (let i = 0; i < end; i += 1) if (source[i] === "\n") line += 1;
  return line;
}

/**
 * Best-effort check that the test EXECUTED the target's changed lines, from a V8 coverage document
 * (NODE_V8_COVERAGE). For the target file's script, every function range with count>0 marks its
 * [startLine,endLine] covered; the changed lines must all fall in a covered range. Fail-CLOSED: if the
 * target script is absent from the coverage (the test never loaded it) or NO changed line is covered, it
 * returns false. An EMPTY changedLines list can't be verified → returns false (the caller must supply the
 * diff lines; a refactor with no known changed lines shouldn't pass the "executes the change" bar blind).
 */
export function changedLinesCovered(coverageDoc, absTargetPath, source, changedLines) {
  const changed = (Array.isArray(changedLines) ? changedLines : []).filter((n) => Number.isFinite(n));
  if (changed.length === 0) return false;
  const results = coverageDoc?.result ?? [];
  const norm = (u) => {
    try { return path.resolve(u.startsWith("file:") ? new URL(u).pathname.replace(/^\/([A-Za-z]:)/, "$1") : u); } catch { return u; }
  };
  const target = norm(absTargetPath);
  const script = results.find((r) => norm(String(r.url ?? "")) === target);
  if (!script) return false;
  const coveredLines = new Set();
  for (const fn of script.functions ?? []) {
    for (const range of fn.ranges ?? []) {
      if ((range.count ?? 0) <= 0) continue;
      const from = offsetToLine(source, range.startOffset ?? 0);
      const to = offsetToLine(source, range.endOffset ?? 0);
      for (let l = from; l <= to; l += 1) coveredLines.add(l);
    }
  }
  return changed.every((l) => coveredLines.has(l));
}

/**
 * Build the acceptCharTest harness for a Node target. `deps`:
 *   - runCommand(cmd, args, { cwd, env, timeoutMs }) -> { status, stdout, timedOut }   (injected exec)
 *   - readCoverage(dir) -> coverageDoc|null   (merge/read the NODE_V8_COVERAGE json in dir; injected fs)
 *   - source   (the target's CURRENT source text, for offset→line mapping in the coverage check)
 * A run's timeout / non-zero exit / capture fault fails the specific check closed (no throw escapes).
 */
export function makeNodeCharHarness({ cwd, testFile, targetFile, changedLines = [], source = "", runCommand, readCoverage, coverageDir, timeoutMs = 60_000 } = {}) {
  const runOnce = async (extraEnv = {}) => {
    const res = await runCommand("node", ["--test", testFile], { cwd, env: { ...process.env, ...extraEnv }, timeoutMs });
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
      // Vary clock/locale so a hidden TZ/locale dependence the same-process repeat can't see surfaces.
      const r = await runOnce({ TZ: "Pacific/Kiritimati", LANG: "de_DE.UTF-8", LC_ALL: "de_DE.UTF-8" });
      if (r.timedOut || r.status !== 0) return null; // differs from a captured string → acceptCharTest rejects
      return captureObservable(r.stdout);
    },
    executesTarget: async () => {
      if (typeof readCoverage !== "function" || !coverageDir) return false; // can't verify → fail closed
      const r = await runCommand("node", ["--test", testFile], { cwd, env: { ...process.env, NODE_V8_COVERAGE: coverageDir }, timeoutMs });
      if (!r || r.timedOut || r.status !== 0) return false;
      const doc = readCoverage(coverageDir);
      if (!doc) return false;
      return changedLinesCovered(doc, path.isAbsolute(targetFile) ? targetFile : path.join(cwd, targetFile), source, changedLines);
    }
  };
}
