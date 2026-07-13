import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runStructureTransform } from "../plugins/council/scripts/lib/structure-wiring.mjs";
import { makeBuildGit } from "../plugins/council/scripts/lib/build.mjs";
import { runCommand } from "../plugins/council/scripts/lib/process.mjs";
// council-companion.mjs guards main() behind an entry-script check, so a direct import runs no CLI
// (same seam tests/council-companion-cli.test.mjs uses for classifyAuthoredTestRun).
import { makeStructureTransformDeps } from "../plugins/council/scripts/council-companion.mjs";

// M9 LIVE wiring verification — the gap this file closes: a SUCCESSFUL structure transform had only
// ever been observed against in-memory fakes (tests/structure-wiring.test.mjs). Here the REAL
// runStructureTransform drives the REAL adapters makeStructureTransformDeps builds — makeBuildGit
// against a real throwaway git repo, makeStepPorts containment, detectTestCmd + a real `npm test`
// as the full-suite oracle, snapshotViolation as the public-API oracle, the real writeFiles — and
// ONLY the model transports are faked (proposePlan / authorTransform / reviewSeat return
// deterministic replies; a real seat CLI is never spawned). What is asserted was OBSERVED on disk:
// a landed commit with exactly the planned files, or a byte-for-byte restored tree.
//
// Modeled on tests/build.test.mjs's "makeBuildGit against a REAL repo" tests: slow is fine
// (each scenario spawns git + at most two real `npm test` runs), but deterministic, and every
// scenario removes its temp repo again.

// --- environment probes (skip honestly where spawning is impossible; never fake-green) --------------

const gitProbe = spawnSync("git", ["--version"], { encoding: "utf8" });
// npm is a .cmd shim on Windows — probe through the same runCommand the real runFullSuite uses.
const npmProbe = runCommand("npm", ["--version"]);
const skipReason =
  gitProbe.status !== 0
    ? "git is unavailable in this environment — cannot build the throwaway repo"
    : npmProbe.status !== 0
      ? "npm is unavailable in this environment — the REAL detected suite command (npm test) cannot run"
      : null;

// --- the throwaway SSOT-violation repo ---------------------------------------------------------------

// lib/a.mjs and lib/b.mjs carry an IDENTICAL formatDate (the obvious SSOT duplication), lib/use.mjs
// is a real consumer of one duplicate, and a passing node:test suite pins the behaviour of all three.
const A_SRC = [
  "// lib/a.mjs — duplicate #1 of formatDate (the SSOT violation under test)",
  "export function formatDate(iso) {",
  '  const [y, m, d] = String(iso).split("-");',
  '  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;',
  "}",
  ""
].join("\n");

// The extra shortDate export is deliberately NOT exercised by the suite: removing it keeps the suite
// green, so only the public-API gate can catch that removal (scenario 5 is discriminating).
const B_SRC = [
  "// lib/b.mjs — duplicate #2 of formatDate, plus an export the suite does NOT exercise",
  "export function formatDate(iso) {",
  '  const [y, m, d] = String(iso).split("-");',
  '  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;',
  "}",
  "",
  "export function shortDate(iso) {",
  "  return formatDate(iso).slice(5);",
  "}",
  ""
].join("\n");

const USE_SRC = [
  "// lib/use.mjs — a real consumer of one duplicate (must keep working after the consolidation)",
  'import { formatDate } from "./a.mjs";',
  "",
  "export function stampLine(label, iso) {",
  "  return `${label}: ${formatDate(iso)}`;",
  "}",
  ""
].join("\n");

const SUITE_SRC = [
  'import assert from "node:assert/strict";',
  'import test from "node:test";',
  "",
  'import { formatDate as fromA } from "../lib/a.mjs";',
  'import { formatDate as fromB } from "../lib/b.mjs";',
  'import { stampLine } from "../lib/use.mjs";',
  "",
  'test("formatDate pads month and day", () => {',
  '  assert.equal(fromA("2026-1-5"), "2026-01-05");',
  '  assert.equal(fromB("2026-1-5"), "2026-01-05");',
  "});",
  "",
  'test("both duplicates agree on the behaviour", () => {',
  '  assert.equal(fromA("1999-12-31"), fromB("1999-12-31"));',
  "});",
  "",
  'test("the consumer composes the formatted date", () => {',
  '  assert.equal(stampLine("due", "2026-1-5"), "due: 2026-01-05");',
  "});",
  ""
].join("\n");

// The fixture's suite entry. Two hazards make a bare `node --test tests/` script NON-discriminating
// here, both verified live while building this file:
//   1. env inheritance: the REAL runFullSuite adapter spawns `npm test` with the COUNCIL process's
//      env (runCommandAsync defaults to process.env). This e2e file itself runs under `node --test`,
//      whose children carry NODE_TEST_CONTEXT=child-v8 — and a nested `node --test` under that var
//      exits 0 WITH NO TESTS RUN even on a red tree (observed: a false-GREEN suite oracle). The
//      fixture's own runner therefore scrubs the test-runner env before spawning its suite, exactly
//      like a real-world suite wrapper would.
//   2. `node --test tests/` (trailing-slash dir positional) does not discover tests on some Node
//      lines (observed MODULE_NOT_FOUND on v22.13); the explicit test-file path is deterministic.
const RUN_SRC = [
  "// suite wrapper: run the node:test suite with a CLEAN test-runner env, propagate its exit code",
  'import { spawnSync } from "node:child_process";',
  "",
  "const env = { ...process.env };",
  "delete env.NODE_TEST_CONTEXT; // a nested runner must never think it is a child of an outer one",
  "delete env.NODE_OPTIONS;",
  'const r = spawnSync(process.execPath, ["--test", "tests/format-date.test.mjs"], { stdio: "inherit", env });',
  "process.exit(r.status ?? 1);",
  ""
].join("\n");

// detectTestCmd(root) finds this script and the REAL runFullSuite runs it via `npm test --silent`.
const PKG_SRC = `${JSON.stringify(
  { name: "structure-e2e-fixture", version: "1.0.0", private: true, scripts: { test: "node tests/run.mjs" } },
  null,
  2
)}\n`;

const FIXTURE = Object.freeze({
  "package.json": PKG_SRC,
  "lib/a.mjs": A_SRC,
  "lib/b.mjs": B_SRC,
  "lib/use.mjs": USE_SRC,
  "tests/run.mjs": RUN_SRC,
  "tests/format-date.test.mjs": SUITE_SRC
});

// --- the deterministic "model" replies -----------------------------------------------------------------

const PLAN = Object.freeze({
  type: "consolidate-ssot",
  rationale: "keep ONE formatDate implementation in lib/b.mjs and re-export it from lib/a.mjs so both import paths keep working",
  plannedTouched: ["lib/a.mjs", "lib/b.mjs"]
});

// A correct consolidation: a.mjs becomes a re-export (surface unchanged — parseModule counts a
// re-exported name), b.mjs stays the SSOT (only its header comment changes, so the drift gate sees
// BOTH planned files change while behaviour and surface stay identical).
const NEW_A = [
  "// lib/a.mjs — consolidated: formatDate now has ONE source of truth in lib/b.mjs",
  'export { formatDate } from "./b.mjs";',
  ""
].join("\n");

const NEW_B = [
  "// lib/b.mjs — the single source of truth for formatDate after the consolidation",
  "export function formatDate(iso) {",
  '  const [y, m, d] = String(iso).split("-");',
  '  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;',
  "}",
  "",
  "export function shortDate(iso) {",
  "  return formatDate(iso).slice(5);",
  "}",
  ""
].join("\n");

// Behaviour-BREAKING variant (scenario 4): slashes instead of dashes → the fixture suite fails at
// ASSERTION level, so the real npm run exits non-zero and the fullSuite gate must revert.
const NEW_B_RED = NEW_B.replace('return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;', 'return `${y}/${String(m).padStart(2, "0")}/${String(d).padStart(2, "0")}`;');

// API-BREAKING variant (scenario 5): shortDate removed. The suite never calls it, so the suite stays
// GREEN — only snapshotViolation (the real checkPublicApi) can catch the removed export.
const NEW_B_NO_EXPORT = [
  "// lib/b.mjs — the single source of truth for formatDate after the consolidation",
  "export function formatDate(iso) {",
  '  const [y, m, d] = String(iso).split("-");',
  '  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;',
  "}",
  ""
].join("\n");

const HAPPY_FILES = Object.freeze({ "lib/a.mjs": NEW_A, "lib/b.mjs": NEW_B });

const CONFIRM_TEXT = "VERDICT: CONFIRM\nREASON: minimal behaviour-preserving consolidation of the duplicated helper";

function makeFinding() {
  return {
    lens: "architecture_ssot",
    category: "duplication", // non-blank + non-sensitive → single consent suffices
    severity: "P2",
    file: "lib/a.mjs",
    title: "formatDate duplicated across lib/a.mjs and lib/b.mjs",
    detail: "lib/a.mjs and lib/b.mjs carry byte-identical formatDate implementations; consolidate to one SSOT"
  };
}

// --- repo + deps helpers ---------------------------------------------------------------------------------

function makeSsotRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "council-structure-e2e-"));
  const raw = (args) => {
    const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout;
  };
  for (const [rel, content] of Object.entries(FIXTURE)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  raw(["init", "-q"]);
  raw(["config", "user.email", "council@test.invalid"]);
  raw(["config", "user.name", "council-test"]);
  // Pin line endings: a global core.autocrlf=true would rewrite LF -> CRLF on the reset --hard
  // restore and break the byte-for-byte assertions below (same pin as tests/build.test.mjs).
  raw(["config", "core.autocrlf", "false"]);
  raw(["add", "-A"]);
  raw(["commit", "-q", "-m", "base: duplicated formatDate helper", "--no-verify"]);
  return { dir, raw };
}

function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* best effort — a leftover temp dir must not fail the verification itself */
  }
}

/**
 * The REAL deps, faked ONLY at the model seams. makeStructureTransformDeps is the exact factory the
 * CLI's structure pass uses (makeStepPorts containment reads, the containment-guarded writeFiles,
 * detectTestCmd + npm for runFullSuite, snapshotViolation for checkPublicApi, makeBuildGit for git);
 * proposePlan / authorTransform / reviewSeat are replaced with deterministic replies because they
 * are the model transports (empty backends → no reachable seat → they could only fail closed).
 * runFullSuite is the REAL adapter wrapped with a call counter (delegation only — the npm run is real).
 */
function makeE2eDeps(dir, { files = HAPPY_FILES, onAuthor = null, verdictFor = null } = {}) {
  const git = makeBuildGit(dir);
  const base = makeStructureTransformDeps(dir, dir, {}, {}, git);
  const counters = { suiteRuns: 0, reviews: [] };
  const realSuite = base.runFullSuite;
  const deps = {
    ...base,
    proposePlan: async () => PLAN,
    authorTransform: async () => {
      if (onAuthor) onAuthor();
      return { files };
    },
    reviewSeat: async (seat, prompt) => {
      counters.reviews.push({ seat, prompt });
      return verdictFor ? verdictFor(seat) : CONFIRM_TEXT;
    },
    runFullSuite: async () => {
      counters.suiteRuns += 1;
      return realSuite();
    },
    options: { structureAutoApply: true }
  };
  return { deps, git, counters };
}

const readRepo = (dir, rel) => fs.readFileSync(path.join(dir, rel), "utf8");

/** The tree must be back at the base commit BYTE-FOR-BYTE: HEAD, cleanliness, every fixture file. */
function assertPristine(dir, raw, git, baseSha) {
  assert.equal(git.head(), baseSha, "HEAD did not move");
  assert.equal(git.isClean(), true, "the working tree is clean after the revert");
  for (const [rel, content] of Object.entries(FIXTURE)) {
    assert.equal(readRepo(dir, rel), content, `${rel} restored byte-for-byte`);
  }
  assert.equal(Number(raw(["rev-list", "--count", "HEAD"]).trim()), 1, "no commit landed");
}

// --- 1. the LIVE apply ------------------------------------------------------------------------------------

test("LIVE APPLY: unanimity + green suite + stable API ⇒ a real commit of EXACTLY the planned files, duplication gone, suite still green", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const { dir, raw } = makeSsotRepo();
  try {
    const { deps, git, counters } = makeE2eDeps(dir);
    const baseSha = git.head();

    const res = await runStructureTransform({ finding: makeFinding(), snapshot: baseSha }, deps);

    // The transform APPLIED — every gate green, observed on the real ladder result.
    assert.equal(res.applied, true, `expected an applied transform, got: ${res.reason}`);
    assert.equal(res.ok, true);
    assert.equal(res.proposeOnly, false);
    assert.equal(res.stranded, false);
    assert.equal(res.gate?.approved, true);
    for (const g of ["deps", "disposition", "preconditions", "plan", "author", "drift", "fullSuite", "publicApi", "council", "gate", "binding", "commit"]) {
      assert.equal(res.gates[g]?.ok, true, `gate ${g} should be ok`);
    }
    assert.equal(res.modelCalls, 5, "1 plan + 1 author + 3 built-in seat reviews");

    // A REAL commit landed: HEAD moved to it, the tree is clean, one commit on top of base.
    assert.match(String(res.commit), /^[0-9a-f]{40}$/, "commitIndex returned a real sha");
    assert.notEqual(res.commit, baseSha);
    assert.equal(git.head(), res.commit, "HEAD is the transform commit");
    assert.equal(git.isClean(), true, "nothing left uncommitted");
    assert.equal(Number(raw(["rev-list", "--count", "HEAD"]).trim()), 2, "exactly ONE commit on top of the base");
    assert.match(raw(["log", "-1", "--format=%s"]).trim(), /^council-structure: consolidate-ssot — formatDate duplicated/);

    // The commit contains EXACTLY the planned files — the capability boundary, read back from git.
    const committed = raw(["show", "--name-only", "--format=", "HEAD"]).split("\n").map((s) => s.trim()).filter(Boolean);
    assert.deepEqual(committed.sort(), ["lib/a.mjs", "lib/b.mjs"]);

    // The duplication is GONE on disk: a.mjs is a re-export, b.mjs is the one implementation.
    assert.equal(readRepo(dir, "lib/a.mjs"), NEW_A);
    assert.equal(readRepo(dir, "lib/b.mjs"), NEW_B);
    assert.ok(!readRepo(dir, "lib/a.mjs").includes("function formatDate"), "no second implementation left");

    // Every built-in seat reviewed the REAL staged multi-file diff (actual bytes, not a summary).
    assert.deepEqual(counters.reviews.map((r) => r.seat).sort(), ["claude", "codex", "grok"]);
    for (const r of counters.reviews) {
      assert.match(r.prompt, /--- BEGIN MULTI-FILE DIFF [0-9A-F]{12} ---/);
      assert.ok(r.prompt.includes('+export { formatDate } from "./b.mjs";'), "the real diff bytes reached the seat");
      assert.ok(r.prompt.includes("// lib/a.mjs — duplicate #1"), "the removed duplicate is visible in the diff");
    }

    // The REAL suite ran green once inside the gate — and still passes on the COMMITTED tree.
    assert.equal(counters.suiteRuns, 1, "gate 6a ran the suite exactly once");
    const after = await deps.runFullSuite();
    assert.equal(after.ok, true, "npm test is still green on the transformed, committed tree");
  } finally {
    cleanup(dir);
  }
});

// --- 2. a dissenting seat ----------------------------------------------------------------------------------

test("DISSENT: one seat vetoes ⇒ NOT applied, tree reverted byte-for-byte, the finding stays a proposal with the reason", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const { dir, raw } = makeSsotRepo();
  try {
    const { deps, git, counters } = makeE2eDeps(dir, {
      verdictFor: (seat) => (seat === "grok" ? "VERDICT: DISSENT\nREASON: the consolidation could drop a divergent edge case of the duplicate" : CONFIRM_TEXT)
    });
    const baseSha = git.head();

    const res = await runStructureTransform({ finding: makeFinding(), snapshot: baseSha }, deps);

    assert.equal(res.applied, false);
    assert.equal(res.proposeOnly, true, "the finding stays a proposal");
    assert.equal(res.rolledBack, true);
    assert.equal(res.stranded, false);
    assert.equal(res.gates.council.ok, false);
    assert.deepEqual(res.gates.council.dissents, ["grok"]);
    assert.match(res.reason, /not unanimous/);
    assert.match(res.reason, /dissent: grok/, "the reason names the vetoing seat");
    assert.equal(res.commit, null);

    // The transform HAD been applied to the tree (suite ran on it) — and was fully undone by git.
    assert.equal(counters.suiteRuns, 1, "the suite gate ran before the council");
    assert.equal(counters.reviews.length, 3, "every seat was consulted");
    assertPristine(dir, raw, git, baseSha);
  } finally {
    cleanup(dir);
  }
});

// --- 3. the capability boundary against a real tree ----------------------------------------------------------

test("BOUNDARY: a stray write OUTSIDE the declared plan ⇒ drift gate reverts the real tree (stray file gone, no suite/council spend)", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const { dir, raw } = makeSsotRepo();
  try {
    // The authored reply is CLEAN — but the transform's write phase leaves a rogue undeclared file
    // on the real tree (any concurrent/buggy writer). Only the git-backed drift gate can see it.
    const { deps, git, counters } = makeE2eDeps(dir, {
      onAuthor: () => fs.writeFileSync(path.join(dir, "lib", "stray.mjs"), "export const sneaky = true;\n")
    });
    const baseSha = git.head();

    const res = await runStructureTransform({ finding: makeFinding(), snapshot: baseSha }, deps);

    assert.equal(res.applied, false);
    assert.equal(res.proposeOnly, true);
    assert.equal(res.gates.drift.ok, false);
    assert.match(res.reason, /unexpected: lib\/stray\.mjs/);
    assert.equal(res.rolledBack, true);
    assert.equal(res.stranded, false);

    // The boundary held on DISK: the untracked stray is cleaned, the planned edits undone.
    assert.equal(fs.existsSync(path.join(dir, "lib", "stray.mjs")), false, "the stray file was removed by the verified revert");
    assertPristine(dir, raw, git, baseSha);

    // Fail-closed spend discipline: a drifted tree is never tested and never shown to a seat.
    assert.equal(counters.suiteRuns, 0, "no suite run on a drifted tree");
    assert.equal(counters.reviews.length, 0, "no council spend on a drifted tree");
  } finally {
    cleanup(dir);
  }
});

test("BOUNDARY: an authored file outside the plan is rejected BEFORE any byte lands on the real tree", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const { dir, raw } = makeSsotRepo();
  try {
    const { deps, git, counters } = makeE2eDeps(dir, {
      files: { ...HAPPY_FILES, "lib/evil.mjs": "export const evil = true;\n" }
    });
    const baseSha = git.head();

    const res = await runStructureTransform({ finding: makeFinding(), snapshot: baseSha }, deps);

    assert.equal(res.applied, false);
    assert.equal(res.gates.author.ok, false);
    assert.match(res.reason, /unexpected: lib\/evil\.mjs/);
    assert.equal(fs.existsSync(path.join(dir, "lib", "evil.mjs")), false, "the undeclared file was never written");
    assertPristine(dir, raw, git, baseSha);
    assert.equal(counters.suiteRuns, 0);
    assert.equal(counters.reviews.length, 0);
  } finally {
    cleanup(dir);
  }
});

// --- 4. a RED suite ------------------------------------------------------------------------------------------

test("RED SUITE: a behaviour-changing transform fails the REAL npm suite ⇒ reverted before any council spend", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const { dir, raw } = makeSsotRepo();
  try {
    const { deps, git, counters } = makeE2eDeps(dir, {
      files: { "lib/a.mjs": NEW_A, "lib/b.mjs": NEW_B_RED } // slashes instead of dashes: assertion-level RED
    });
    const baseSha = git.head();

    const res = await runStructureTransform({ finding: makeFinding(), snapshot: baseSha }, deps);

    assert.equal(res.applied, false);
    assert.equal(res.proposeOnly, true);
    assert.equal(res.gates.fullSuite.ok, false);
    assert.match(res.reason, /full test suite RED/);
    assert.equal(res.rolledBack, true);
    assert.equal(res.stranded, false);
    assert.equal(counters.suiteRuns, 1, "the real suite ran (and was red) exactly once");
    assert.equal(counters.reviews.length, 0, "a red tree is never shown to the council");
    assertPristine(dir, raw, git, baseSha);

    // The revert is BEHAVIOURALLY complete too: the restored tree's real suite is green again.
    const restored = await deps.runFullSuite();
    assert.equal(restored.ok, true, "npm test is green again on the restored tree");
  } finally {
    cleanup(dir);
  }
});

// --- 5. a public-API change --------------------------------------------------------------------------------

test("PUBLIC API: a removed export the suite cannot see ⇒ the REAL snapshot gate blocks and reverts (suite alone stayed green)", async (t) => {
  if (skipReason) return t.skip(skipReason);
  const { dir, raw } = makeSsotRepo();
  try {
    const { deps, git, counters } = makeE2eDeps(dir, {
      files: { "lib/a.mjs": NEW_A, "lib/b.mjs": NEW_B_NO_EXPORT } // shortDate dropped — unused by the suite
    });
    const baseSha = git.head();

    const res = await runStructureTransform({ finding: makeFinding(), snapshot: baseSha }, deps);

    assert.equal(res.applied, false);
    assert.equal(res.proposeOnly, true);
    // DISCRIMINATING: the suite gate PASSED (the removal is invisible to the tests) — only the
    // snapshotViolation-backed checkPublicApi caught the removed export. Tests-green is not enough.
    assert.equal(res.gates.fullSuite.ok, true, "the real suite could not see the removal");
    assert.equal(res.gates.publicApi.ok, false);
    assert.match(res.reason, /public API changed/);
    assert.equal(res.rolledBack, true);
    assert.equal(res.stranded, false);
    assert.equal(counters.suiteRuns, 1);
    assert.equal(counters.reviews.length, 0, "an API-breaking tree is never shown to the council");
    assertPristine(dir, raw, git, baseSha);
  } finally {
    cleanup(dir);
  }
});
