// Node / node:test execute-and-capture HARNESS for the §5 char-test gate (chartest-gate.mjs). Supplies
// the acceptCharTest deps (passesOnUnmodified / runs / executesTarget / perturbedRun) by shelling out to
// `node --test`, plus target-DEPENDENCE probing: V8 coverage where the platform permits it, and POISON
// PROBES everywhere else — under the default permission sandbox the inspector is blocked, so coverage
// alone could never accept (council Codex/Claude P1). Two probe granularities: the WHOLE-MODULE probe
// (buildPoisonedSource — every export throws) proves the test depends on the module at all, and the
// PER-EXPORT probe (changedExportsFor + buildExportPoisonedSource — ONLY the export containing the
// changed lines throws, every other export keeps its real implementation) proves the test exercises the
// CHANGED region, at export granularity, with no inspector. The harness runs the test against the
// CURRENT working tree, so the CALLER sequences it: accept BEFORE applying the refactor (tree =
// original), verify AFTER.
//
// The generator is prompted to console.log(JSON.stringify(observable)); captureObservable isolates those
// JSON lines from the TAP/timing noise so DETERMINISM reflects the OBSERVABLE, not the runner's varying
// duration_ms. Pure helpers (captureObservable, changedLinesCovered, buildPoisonedSource,
// changedExportsFor, buildExportPoisonedSource) are exported + unit-tested; the subprocess/fs
// orchestration is injected (runCommand/readCoverage/readFile/writeFile) so it stays testable and
// fail-closed.
import path from "node:path";
import { fileURLToPath } from "node:url";

import { exportSnapshot } from "./audit-snapshot.mjs";
import { stripComments } from "./import-graph.mjs";

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

// One top-level export DECLARATION line, classified by form. ESM exports are top-level by grammar, so a
// line-anchored scan over the comment-stripped source (stripComments preserves line structure) finds
// them; a look-alike inside a template literal is a known heuristic gap SHARED with exportSnapshot's
// regex parser. The heuristic is only ever used in the fail-closed direction: a mis-scan makes
// attribution or the single-export transform bail (→ whole-module probe, disclosed), never a finer claim.
const EXPORT_DEFAULT_LINE = /^\s*export\s+default\b/;
const EXPORT_NAMED_LINE = /^\s*export\s+(?:(?:async\s+)?function\s*\*?\s*|class\s+|(?:const|let|var)\s+)([A-Za-z_$][A-Za-z0-9_$]*)/;
// export default <NAMED fn/class declaration>: stripping just the `export default ` prefix keeps the
// declaration AND its module-scope name binding (internal references stay real — replacing it with a
// const expression would ReferenceError other exports at load and false-accept the probe).
const DEFAULT_NAMED_DECL = /^(\s*)export\s+default\s+(?=(?:async\s+)?function(?:\s*\*)?\s+[A-Za-z_$]|class\s+[A-Za-z_$])/;

/**
 * Scan a module into EXPORT REGIONS: each top-level export declaration line opens a region that runs to
 * the line before the next export declaration (or EOF) — the heuristic the per-export poison probe uses
 * to attribute changed lines to the export they fall inside. `poisonable` marks the single-name forms
 * buildExportPoisonedSource can fake (inline function/class/single-binding/default declarations); list,
 * star, destructuring and type-only forms are not — a changed line there degrades to the whole-module
 * probe. Lines 1-based, matching git diff / changedLines conventions.
 */
function exportRegionsOf(source) {
  const lines = stripComments(String(source ?? "")).split("\n");
  const decls = [];
  for (let i = 0; i < lines.length; i += 1) {
    const code = lines[i];
    if (!/^\s*export\b/.test(code)) continue;
    if (EXPORT_DEFAULT_LINE.test(code)) {
      decls.push({ name: "default", poisonable: true, line: i + 1 });
    } else {
      const m = EXPORT_NAMED_LINE.exec(code);
      if (m) decls.push({ name: m[1], poisonable: true, line: i + 1 });
      else decls.push({ name: null, poisonable: false, line: i + 1, form: code.trim().split(/\s+/).slice(0, 2).join(" ") });
    }
  }
  return decls.map((d, idx) => ({ ...d, startLine: d.line, endLine: idx + 1 < decls.length ? decls[idx + 1].line - 1 : lines.length }));
}

/**
 * Attribute the CHANGED lines to the exports whose regions contain them. Returns { exports: [names],
 * reason: null } ONLY when EVERY changed line falls inside a poisonable export's region — "default"
 * names the default export. Anything less confident returns { exports: null, reason } and the caller
 * degrades to the whole-module probe: an un-enumerable (opaque) surface, no export declarations at all,
 * a changed line before the first export / past EOF, or a line inside a list/star/destructuring export.
 * Fail-closed by construction — this can only ever CLAIM LESS granularity than reality, never more.
 */
export function changedExportsFor(source, changedLines) {
  const src = String(source ?? "");
  const changed = (Array.isArray(changedLines) ? changedLines : []).filter((n) => Number.isFinite(n) && n >= 1);
  if (changed.length === 0) return { exports: null, reason: "no changed lines to attribute" };
  if (exportSnapshot(src).opaque) return { exports: null, reason: "export surface un-enumerable (star re-export or whole-module CommonJS)" };
  const regions = exportRegionsOf(src);
  if (regions.length === 0) return { exports: null, reason: "no top-level export declarations found" };
  const names = new Set();
  for (const line of changed) {
    const region = regions.find((r) => line >= r.startLine && line <= r.endLine);
    if (!region) return { exports: null, reason: `changed line ${line} is outside every export region (module-level code before the first export, or past EOF)` };
    if (!region.poisonable) return { exports: null, reason: `changed line ${line} falls in an export form that cannot be singly poisoned (${region.form})` };
    names.add(region.name);
  }
  return { exports: [...names].sort(), reason: null };
}

// For an `export const|let|var NAME = ...` declaration, confirm the statement declares ONLY that one
// binding: walk it (bracket-depth + string aware) to its terminating depth-0 `;` and reject any depth-0
// comma — un-exporting `export const a = 1, b = 2` would silently DROP b from the twin's surface, and
// exportSnapshot shares the single-name regex blindness, so the post-hoc snapshot compare CANNOT see
// that drift. Any scan anomaly (unterminated statement / ASI, negative depth) also rejects: fail closed.
function singleBindingDeclarator(strippedLines, startIdx) {
  let depth = 0;
  let quote = null;
  for (let i = startIdx; i < strippedLines.length; i += 1) {
    const line = strippedLines[i];
    for (let j = 0; j < line.length; j += 1) {
      const ch = line[j];
      if (quote) {
        if (ch === "\\") { j += 1; continue; }
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
      if (ch === "(" || ch === "[" || ch === "{") { depth += 1; continue; }
      if (ch === ")" || ch === "]" || ch === "}") { depth -= 1; if (depth < 0) return false; continue; }
      if (depth === 0 && ch === ",") return false;
      if (depth === 0 && ch === ";") return true;
    }
    if (quote === "'" || quote === '"') quote = null; // an ordinary string cannot span lines
  }
  return false; // no terminating `;` found (ASI / scan confusion) — fail closed
}

/**
 * Build a PER-EXPORT poisoned variant: the real module with ONLY `exportName` replaced (as seen by an
 * importer) by a function that throws POISON_SENTINEL — every other export keeps its real
 * implementation, so a test that exercises THEM is untouched and only dependence on the POISONED export
 * can change the outcome. The transform is binding-level: the declaration merely loses its `export`
 * prefix (the real implementation stays defined and internally callable — no load-time explosion a
 * module-level call into the poisoned export could otherwise cause) and the poison is re-exported under
 * the same name. Returns null — the caller degrades to the whole-module probe — whenever the single
 * declaration cannot be located unambiguously, the transform did not apply cleanly, or the variant's
 * enumerable export surface is not IDENTICAL to the original's (the post-hoc guard that catches every
 * regex misfire, e.g. a multi-declarator `export const a = 1, b = 2`): no probe > a probe that can lie.
 */
export function buildExportPoisonedSource(source, exportName) {
  const src = String(source ?? "");
  const name = String(exportName ?? "");
  if (name !== "default" && !PLAIN_IDENT.test(name)) return null;
  if (src.includes("__councilPoison__") || src.includes("__councilRealDefault__")) return null; // the twin's identifiers must be fresh
  const before = exportSnapshot(src);
  if (before.opaque) return null;
  if (name === "default" ? !before.hasDefault : !before.names.includes(name)) return null;
  const matches = exportRegionsOf(src).filter((r) => r.poisonable && r.name === name);
  if (matches.length !== 1) return null; // absent or ambiguous (e.g. a string/template look-alike) — fail closed
  const lines = src.split("\n");
  const idx = matches[0].startLine - 1;
  const stripped = stripComments(src).split("\n");
  if (/^\s*export\s+(?:const|let|var)\b/.test(stripped[idx]) && !singleBindingDeclarator(stripped, idx)) return null;
  const line = lines[idx];
  let replaced;
  if (name === "default") {
    replaced = DEFAULT_NAMED_DECL.test(line)
      ? line.replace(DEFAULT_NAMED_DECL, "$1") // named declaration: keep it + its binding, just un-export
      : line.replace(/^(\s*)export\s+default\b\s*/, "$1const __councilRealDefault__ = "); // expression/anonymous form
  } else {
    replaced = line.replace(/^(\s*)export\s+/, "$1");
  }
  if (replaced === line) return null; // the raw line did not match the classified shape (comment/edge) — fail closed
  lines[idx] = replaced;
  const tail = [
    "// COUNCIL §5 PER-EXPORT POISON PROBE — transient stand-in written by the (unsandboxed) char-test harness.",
    "// If this text survives in a working tree, a probe RESTORE FAILED: recover the file from VCS.",
    `function __councilPoison__() { throw new Error("${POISON_SENTINEL}"); }`,
    name === "default" ? "export default __councilPoison__;" : `export { __councilPoison__ as ${name} };`
  ];
  const poisoned = `${lines.join("\n")}\n${tail.join("\n")}\n`;
  const after = exportSnapshot(poisoned);
  if (after.opaque || after.hasDefault !== before.hasDefault) return null;
  if (JSON.stringify(after.names) !== JSON.stringify(before.names)) return null; // surface drift = a lying twin — fail closed
  return poisoned;
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

  // Run the SAME hashed test once against a poisoned twin of the target, restoring the original in a
  // finally (FATAL + loud on restore failure, via restoreTarget above). Returns true/false = "the outcome
  // (exit status or captured observable) DIFFERS from the real baseline", or null when the poisoned run
  // did not complete — the caller fails that closed with its own honest note.
  const poisonedRunDiffers = async (original, poisonedSource, realObs) => {
    let poisonRun = null;
    try {
      writeFile(absTarget, poisonedSource);
      poisonRun = await runOnce(); // the SAME test under the SAME sandbox — only the target differs
    } finally {
      restoreTarget(original); // ALWAYS restore; throws FATAL on failure — never a silent poisoned tree
    }
    if (!poisonRun || poisonRun.timedOut) return null;
    if (poisonRun.status !== 0) return true; // the test FAILS with the poison in place → it depends on it
    return captureObservable(poisonRun.stdout) !== realObs; // or its observable differs → depends
  };

  // WHOLE-MODULE POISON PROBE — the inspector-free target-dependence check that works under the FULL
  // sandbox (council Codex/Claude P1: NODE_V8_COVERAGE is inspector-based, and the permission model
  // restricts the inspector UNCONDITIONALLY — no --allow-* flag re-grants it, confirmed on v22.13.1 — so
  // the old coverage-only checks rejected EVERY refactor). The harness is the trusted, unsandboxed
  // parent, so IT may rewrite the target: run the test against the REAL target, then against a POISONED
  // twin (same export surface, every export throws), and require the outcomes to DIFFER. An identical
  // pass = the test does not depend on the target — this catches strictly MORE than coverage did
  // ("imports the target unused + asserts 1===1" passes unchanged with the target poisoned, and is
  // rejected here, while coverage only proved a line had LOADED). Fail-CLOSED at every step: missing fs
  // deps, an unreadable target, an un-fakeable surface, a failed baseline, or a timed-out poison run all
  // return false with an honest note; the restore is guarded above (fatal, never silent).
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
    const differs = await poisonedRunDiffers(original, poisoned, captureObservable(real.stdout));
    if (differs == null) {
      notes.push("poison probe run did not complete — fail closed");
      return false;
    }
    if (differs) return true;
    notes.push("the test does not depend on the target (poison probe: it passed unchanged with the target poisoned)");
    return false;
  };

  // PER-EXPORT POISON PROBE — closes the granularity gap the sandbox left open: the whole-module probe
  // proves the test depends on the MODULE, but not that it exercises the CHANGED region. Here the changed
  // lines are attributed to the export region(s) they fall inside (changedExportsFor), and for EACH such
  // export the SAME hashed test is re-run under the SAME full sandbox against a variant where ONLY that
  // export is poisoned while every other export keeps its real implementation. Every changed export's
  // poisoning must change the outcome; one unchanged outcome = the test does not exercise that region →
  // reject with the honest cause. When per-export granularity CANNOT be established (no fs deps,
  // unreadable target, un-attributable lines, an un-fakeable single export), it DEGRADES to the
  // whole-module probe and SAYS SO in a note — coarser granularity is disclosed, never silently upgraded.
  const perExportProbe = async () => {
    const degrade = (why) => {
      notes.push(`changed-line coverage unavailable under the sandbox and ${why} — degrading to the WHOLE-MODULE poison probe (per-export granularity NOT established)`);
      return poisonProbe();
    };
    if (typeof readFile !== "function" || typeof writeFile !== "function") return degrade("the per-export probe has no injected readFile/writeFile");
    let original;
    try {
      original = readFile(absTarget);
    } catch (err) {
      return degrade(`the target could not be read (${String(err?.message ?? err)})`);
    }
    const attributed = changedExportsFor(original, changedLines);
    if (!attributed.exports) return degrade(`the changed lines could not be attributed to a specific export (${attributed.reason})`);
    // build EVERY variant before the first run: one un-fakeable export degrades the whole check — a
    // half-measured claim ("some of the changed exports were probed") would be finer than was established
    const variants = [];
    for (const name of attributed.exports) {
      const variant = buildExportPoisonedSource(original, name);
      if (variant == null) return degrade(`export '${name}' could not be singly poisoned`);
      variants.push([name, variant]);
    }
    notes.push(`changed-line coverage unavailable under the sandbox — measured by the PER-EXPORT poison probe instead: changed lines attributed to export(s) ${attributed.exports.map((n) => `'${n}'`).join(", ")} (export granularity; line granularity not established)`);
    const real = await runOnce();
    if (!real || real.timedOut || real.status !== 0) {
      notes.push("per-export poison probe could not establish a passing baseline run — fail closed");
      return false;
    }
    const realObs = captureObservable(real.stdout);
    for (const [name, variant] of variants) {
      const differs = await poisonedRunDiffers(original, variant, realObs);
      if (differs == null) {
        notes.push(`per-export poison run for export '${name}' did not complete — fail closed`);
        return false;
      }
      if (!differs) {
        notes.push(`the test does not exercise the changed export '${name}' — it does not depend on the target's changed region (per-export poison probe: it passed unchanged with only '${name}' poisoned)`);
        return false;
      }
    }
    return true;
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
    // poisonProbe), so this DEGRADES HONESTLY: fall back to the PER-EXPORT poison probe (poisoning the
    // export that CONTAINS the changed lines must change the test's outcome — export granularity), and
    // where even that cannot be established, to the whole-module probe — each step recorded in notes,
    // never claiming finer granularity than was measured. The load-bearing behaviour check remains the
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
      return perExportProbe();
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
