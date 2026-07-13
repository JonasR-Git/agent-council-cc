// Node / node:test execute-and-capture HARNESS for the §5 char-test gate (chartest-gate.mjs). Supplies
// the acceptCharTest deps (passesOnUnmodified / runs / executesTarget / perturbedRun) by shelling out to
// `node --test`, plus target-DEPENDENCE probing: V8 coverage where the platform permits it, and a POISON
// PROBE (buildPoisonedSource) everywhere else — under the default permission sandbox the inspector is
// blocked, so coverage alone could never accept (council Codex/Claude P1). The harness runs the test
// against the CURRENT working tree, so the CALLER sequences it: accept BEFORE applying the refactor
// (tree = original), verify AFTER.
//
// The generator is prompted to console.log(JSON.stringify(observable)); captureObservable isolates those
// JSON lines from the TAP/timing noise so DETERMINISM reflects the OBSERVABLE, not the runner's varying
// duration_ms. Pure helpers (captureObservable, changedLinesCovered, buildPoisonedSource) are exported +
// unit-tested; the subprocess/fs orchestration is injected (runCommand/readCoverage/readFile/writeFile)
// so it stays testable and fail-closed.
import path from "node:path";
import { fileURLToPath } from "node:url";

import { exportSnapshot } from "./audit-snapshot.mjs";

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
 * via console.log(JSON.stringify(...)). Node's TAP reporter re-emits a test's console.log output as a
 * `# `-prefixed diagnostic (verified on v22.13.1: `console.log(JSON.stringify({sum:5}))` arrives as the
 * stdout line `# {"sum":5}`, NOT a bare `{"sum":5}`), so only that leading `#` framing is stripped — never
 * the whole line — before the JSON.parse probe; a bare (unframed) JSON line is still recognized too. TAP
 * status lines, the volatile duration_ms/summary comments ("# tests 1", "# Subtest: …"), YAML diagnostic
 * lines, and blanks are not valid JSON and are dropped, so two runs of a DETERMINISTIC target yield an
 * identical capture while runner timing does not. Returns the joined JSON observable lines ("" if the test
 * printed none → acceptCharTest then rejects it as vacuous).
 */
export function captureObservable(stdout) {
  const out = [];
  for (const raw of String(stdout ?? "").split(/\r?\n/)) {
    const t = raw.trim();
    if (!t) continue;
    if (t === "TAP version 13" || /^(ok|not ok)\b/.test(t) || /^\d+\.\.\d+$/.test(t)) continue;
    // Strip ONLY a leading `#` (+ whitespace) TAP-diagnostic framing prefix, not the payload underneath —
    // dropping the whole line here (the prior bug) discards the ONLY channel the generator is prompted to
    // use, silently turning every run vacuous.
    const candidate = t.startsWith("#") ? t.slice(1).trim() : t;
    if (!candidate) continue;
    try {
      JSON.parse(candidate);
      out.push(candidate); // a JSON value line (bare, or "# "-framed by the runner) = an emitted observable
    } catch {
      /* not an observable line (TAP framing / prose / YAML diagnostics) — ignore */
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

// Thrown by every export of a POISONED target. Unique enough that no real module produces it, so any
// behavioural difference under poison is attributable to the probe, never to the target itself.
export const POISON_SENTINEL = "__COUNCIL_POISON__";

// A poisoned stand-in must RELIABLY LOAD: a load-time explosion would make even an import-unused test
// fail under poison and be falsely accepted as "depends on the target". So only plain-identifier export
// names are faked; anything weirder fails closed (no probe > a probe that can lie).
const PLAIN_IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Build a POISONED stand-in for a target module: it still parses, loads side-effect-free, and exports the
 * SAME surface (names + default, via audit-snapshot's export extractor), but every export is one shared
 * function that throws POISON_SENTINEL when called — and, being a fresh function object, is a sentinel
 * VALUE equal to nothing the real module could have produced (JSON.stringify drops/nulls it, so a printed
 * observable differs too). A test that still passes IDENTICALLY against this stand-in cannot depend on
 * the target. Returns null (→ the probe fails closed) when the surface is OPAQUE (star re-export /
 * whole-module CommonJS) or an export name is not a plain identifier.
 */
export function buildPoisonedSource(source) {
  const snap = exportSnapshot(String(source ?? ""));
  if (snap.opaque) return null;
  const names = snap.names.filter((n) => n !== "default"); // a default export is re-emitted below, not aliased
  if (!names.every((n) => PLAIN_IDENT.test(n))) return null;
  const lines = [
    "// COUNCIL §5 POISON PROBE — transient stand-in written by the (unsandboxed) char-test harness.",
    "// If this text survives in a working tree, a probe RESTORE FAILED: recover the file from VCS.",
    `function __councilPoison__() { throw new Error("${POISON_SENTINEL}"); }`
  ];
  for (const n of names) lines.push(`export { __councilPoison__ as ${n} };`); // reserved-word aliases are legal ESM
  if (snap.hasDefault) lines.push("export default __councilPoison__;");
  return `${lines.join("\n")}\n`;
}

/**
 * Build the acceptCharTest harness for a Node target. `deps`:
 *   - runCommand(cmd, args, { cwd, env, timeoutMs }) -> { status, stdout, timedOut }   (injected exec)
 *   - readCoverage(dir) -> coverageDoc|null   (merge/read the NODE_V8_COVERAGE json in dir; injected fs)
 *   - readFile(p) / writeFile(p, s)           (injected fs for the POISON PROBE: the harness — our own
 *     trusted, UNSANDBOXED parent process — swaps the target for a poisoned twin and restores it; the
 *     sandboxed test itself may never write)
 *   - source   (the target's CURRENT source text, for offset→line mapping in the coverage check)
 * A run's timeout / non-zero exit / capture fault fails the specific check closed (no throw escapes),
 * with ONE exception: a failed poison-probe RESTORE throws FATAL(chartest-poison-restore) — a silently
 * poisoned working tree is the one fault that must never be swallowed. The returned `notes` array
 * collects honest probe caveats (why a probe rejected / degraded) for the wiring to surface in reasons.
 */
export function makeNodeCharHarness({ cwd, testFile, targetFile, changedLines = [], source = "", runCommand, readCoverage, coverageDir, timeoutMs = 60_000, sandboxArgs, readFile, writeFile } = {}) {
  // SANDBOX the model-generated test (council Grok P0 — RCE): the test body is written by a seat that saw
  // untrusted target source, then executed by `node --test`. Node's permission model
  // (--experimental-permission) DENIES child_process (no shell/spawn/curl) and fs WRITES by default — the
  // two vectors a prompt-injected test would use to tamper or persist. fs READS are allowed (the test must
  // import the target; source read-exfil is no worse than the audit already sending source to the model
  // seats). `node --test` ALSO spawns a CHILD PROCESS per test file by default (isolation:"process") —
  // that spawn is itself denied under the permission model unless child_process is granted, which would
  // reopen the very RCE vector this sandbox exists to close (verified empirically on v22.13.1: without
  // this flag, `node --experimental-permission --allow-fs-read=* --test file.mjs` exits 1 with
  // ERR_ACCESS_DENIED at ChildProcess.spawn, so NO refactor could ever pass — every run was silently
  // downgraded to propose-only). `--experimental-test-isolation=none` runs the (single, already-authored)
  // test file in the CURRENT process instead, so no child_process permission is ever needed. A node too
  // old to support a flag here simply errors → the run fails → fail-CLOSED (propose-only). Overridable
  // via sandboxArgs (tests pass []); the coverage run additionally allows writing its dir.
  const baseSandbox = Array.isArray(sandboxArgs)
    ? sandboxArgs
    : ["--experimental-permission", "--allow-fs-read=*", "--experimental-test-isolation=none"];
  const runOnce = async (extraEnv = {}, extraArgs = []) => {
    const res = await runCommand("node", [...baseSandbox, ...extraArgs, "--test", testFile], { cwd, env: { ...process.env, ...extraEnv }, timeoutMs });
    return res ?? { status: 1, stdout: "", timedOut: false };
  };
  const absTarget = path.isAbsolute(targetFile) ? targetFile : path.join(cwd, String(targetFile ?? ""));
  const notes = []; // honest probe caveats/causes; chartest-wiring appends them to its reject/pass reasons
  let restoreFailure = null; // set (then thrown) when the target could not be un-poisoned — fatal + loud

  // Put the ORIGINAL source back after a poison run. Retries, verifies by read-back (byte-for-byte for
  // the utf8 sources this repo audits), and treats "already original" as restored (covers a failed poison
  // write). A restore that still fails is FATAL: it THROWS (never returns a verdict) so no caller can
  // mistake a poisoned working tree for a mere probe rejection.
  const restoreTarget = (original) => {
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        if (readFile(absTarget) === original) return; // already byte-identical
        writeFile(absTarget, original);
        if (readFile(absTarget) === original) return;
        lastErr = new Error("post-restore read-back does not match the original source");
      } catch (err) {
        lastErr = err;
      }
    }
    restoreFailure = lastErr ?? new Error("unknown restore failure");
    throw new Error(`FATAL(chartest-poison-restore): could not restore ${absTarget} after the poison probe (${String(restoreFailure?.message ?? restoreFailure)}) — the working tree may still contain a POISONED target; recover the file from VCS before trusting any further result`);
  };

  // POISON PROBE — the inspector-free target-dependence check that works under the FULL sandbox (council
  // Codex/Claude P1: NODE_V8_COVERAGE is inspector-based, and the permission model restricts the
  // inspector UNCONDITIONALLY — no --allow-* flag re-grants it, confirmed on v22.13.1 — so the old
  // coverage-only checks rejected EVERY refactor). The harness is the trusted, unsandboxed parent, so IT
  // may rewrite the target: run the test against the REAL target, then against a POISONED twin (same
  // export surface, every export throws), and require the outcomes to DIFFER. An identical pass = the
  // test does not depend on the target — this catches strictly MORE than coverage did ("imports the
  // target unused + asserts 1===1" passes unchanged with the target poisoned, and is rejected here, while
  // coverage only proved a line had LOADED). Fail-CLOSED at every step: missing fs deps, an unreadable
  // target, an un-fakeable surface, a failed baseline, or a timed-out poison run all return false with an
  // honest note; the restore is guarded above (fatal, never silent).
  const poisonProbe = async () => {
    if (typeof readFile !== "function" || typeof writeFile !== "function") {
      notes.push("poison probe unavailable (no injected readFile/writeFile) — fail closed");
      return false;
    }
    let original;
    try {
      original = readFile(absTarget);
    } catch (err) {
      notes.push(`poison probe could not read the target (${String(err?.message ?? err)}) — fail closed`);
      return false;
    }
    const poisoned = buildPoisonedSource(original);
    if (poisoned == null) {
      notes.push("poison probe cannot fake the target's export surface (opaque or non-identifier exports) — fail closed");
      return false;
    }
    const real = await runOnce();
    if (!real || real.timedOut || real.status !== 0) {
      notes.push("poison probe could not establish a passing baseline run — fail closed");
      return false;
    }
    const realObs = captureObservable(real.stdout);
    let poisonRun = null;
    try {
      writeFile(absTarget, poisoned);
      poisonRun = await runOnce(); // the SAME test under the SAME sandbox — only the target differs
    } finally {
      restoreTarget(original); // ALWAYS restore; throws FATAL on failure — never a silent poisoned tree
    }
    if (!poisonRun || poisonRun.timedOut) {
      notes.push("poison probe run did not complete — fail closed");
      return false;
    }
    if (poisonRun.status !== 0) return true; // the test FAILS with the target poisoned → it depends on it
    if (captureObservable(poisonRun.stdout) !== realObs) return true; // its observable differs → depends
    notes.push("the test does not depend on the target (poison probe: it passed unchanged with the target poisoned)");
    return false;
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
    // VERIFY-phase check: does the pinned test exercise the refactor's CHANGED lines? The PREFERRED
    // mechanism is real V8 changed-line coverage — it works when the caller supplies sandboxArgs: []
    // (a trusted/unsandboxed context) or on a future node whose permission model re-grants the inspector.
    // Under the DEFAULT sandbox the coverage document always comes back EMPTY (inspector blocked, see
    // poisonProbe), so this DEGRADES HONESTLY: fall back to the poison probe (the test must depend on the
    // target) and record that changed-LINE granularity could not be established — never claim the changed
    // lines were covered when they were not measured. The load-bearing behaviour check remains the
    // harness-captured observable comparison in chartest-gate.mjs's verifyCharTestAfterFix; this
    // complements it.
    executesTarget: async () => {
      if (typeof readCoverage === "function" && coverageDir) {
        // the coverage run must be allowed to WRITE its NODE_V8_COVERAGE dir under the sandbox
        const r = await runOnce({ NODE_V8_COVERAGE: coverageDir }, [`--allow-fs-write=${coverageDir}`]);
        if (!r || r.timedOut || r.status !== 0) return false; // the RUN itself failed (not a coverage gap) → fail closed
        const doc = readCoverage(coverageDir);
        if (doc) return changedLinesCovered(doc, absTarget, source, changedLines);
        // fall through: the run was green but the document is EMPTY → the sandbox blocked the inspector
      }
      notes.push("changed-line coverage unavailable under the sandbox (measured by the poison probe instead — line granularity not established)");
      return poisonProbe();
    },
    // ACCEPT-phase check (council Grok P1): the test must actually DEPEND on the target — not merely
    // import it unused with a tautology. The poison probe replaces the old executesModule coverage check
    // (permanently false under the sandbox) with a strictly STRONGER signal: coverage proved a line had
    // loaded; the probe proves the test's verdict/observable CHANGES when the target's behaviour does.
    executesModule: () => poisonProbe(),
    notes,
    get restoreFailure() { return restoreFailure; }
  };
}
