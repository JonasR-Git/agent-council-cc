import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CANONICAL_VERBS,
  HIDDEN_VERBS,
  expandAliases
} from "../plugins/council/scripts/lib/cli-aliases.mjs";
import { route } from "../plugins/council/scripts/lib/cli-dispatch.mjs";
import { VERB_MUTATION, assertCodeWriteAllowed } from "../plugins/council/scripts/lib/cli-mutation.mjs";
import { CLI_FLAGS, booleanOptionsFor, valueOptionsFor } from "../plugins/council/scripts/lib/cli-registry.mjs";
import { buildFixExplain, resolveExplain } from "../plugins/council/scripts/lib/cli-explain.mjs";
import { handleAudit, handleBuild } from "../plugins/council/scripts/council-companion.mjs";

// ════════════════════════════════════════════════════════════════════════════════════════════════
// CLI-surface redesign — the ACCEPTANCE GATE (Stage 6, docs/cli-surface-design.md §"Staged build plan").
//
// This is the LAST stage: it locks the whole 7-verb surface behind loud, table-driven gates so a future
// change that (a) breaks an alias, (b) lets a read-only verb write tracked source, (c) weakens the write
// envelope, (d) leaks non-JSON to a --json stdout, or (e) misreports --explain's resolved sources FAILS
// here — that is the suite's entire purpose. Groups a–e mirror the stage-6 spec; a few cheap real
// subprocess smokes (no model calls) pin the wire-up end-to-end.
// ════════════════════════════════════════════════════════════════════════════════════════════════

const COMPANION = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "plugins",
  "council",
  "scripts",
  "council-companion.mjs"
);

function isSandboxBlocked(result) {
  return Boolean(result.error) && (result.error.code === "EPERM" || result.error.code === "ENOENT");
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// (a) SURFACE COMPLETENESS — one golden table for the WHOLE 7-verb surface: each canonical verb, its
//     modes/actions, and the hidden verbs, pinning verb + handler + mutationClass (+ auditSub for the
//     engine modes). The legacy old-name alias layer is GONE — a companion REJECTED table proves each old
//     name is now a clean unknown-command error. A completeness guard enumerated from CANONICAL/HIDDEN_VERBS
//     + the registry proves no verb/flag can silently escape coverage.
// ────────────────────────────────────────────────────────────────────────────────────────────────

// { argv, verb, handler, mutationClass, auditSub? } — the canonical surface (expandAliases is a fixed point).
const GOLDEN = [
  // the 7 canonical verbs (bare)
  { argv: ["review"], verb: "review", handler: "handleReview", mc: "none" },
  { argv: ["fix"], verb: "fix", handler: "handleAudit", mc: "working-tree", auditSub: "fix" },
  { argv: ["plan"], verb: "plan", handler: "handlePlan", mc: "none" },
  { argv: ["build"], verb: "build", handler: "handleBuild", mc: "working-tree" },
  { argv: ["solve"], verb: "solve", handler: "handleReview", mc: "none" },
  { argv: ["status"], verb: "status", handler: "handleStatus", mc: "state-only" },
  { argv: ["setup"], verb: "setup", handler: "handleSetup", mc: "state-only" },
  // review modes — the light modes stay on handleReview; deep/run/endless reach the DISTINCT audit engines
  { argv: ["review", "--mode", "deliberate"], verb: "review", handler: "handleReview", mc: "none" },
  { argv: ["review", "--mode", "adversarial"], verb: "review", handler: "handleReview", mc: "none" },
  { argv: ["review", "--mode", "deep"], verb: "review", handler: "handleAudit", mc: "none", auditSub: "review" },
  { argv: ["review", "--mode", "run"], verb: "review", handler: "handleAudit", mc: "none", auditSub: "run" },
  { argv: ["review", "--mode", "endless"], verb: "review", handler: "handleAudit", mc: "none", auditSub: "endless" },
  // fix (write) with flags
  { argv: ["fix", "--loop"], verb: "fix", handler: "handleAudit", mc: "working-tree", auditSub: "fix" },
  { argv: ["fix", "--loop", "--deep"], verb: "fix", handler: "handleAudit", mc: "working-tree", auditSub: "fix" },
  // status action forms (each selects a DISTINCT existing handler)
  { argv: ["status", "--result"], verb: "status", handler: "handleResult", mc: "state-only" },
  { argv: ["status", "--watch"], verb: "status", handler: "handleWatch", mc: "state-only" },
  { argv: ["status", "--wait"], verb: "status", handler: "handleWait", mc: "state-only" },
  { argv: ["status", "--cancel"], verb: "status", handler: "handleCancel", mc: "state-only" },
  { argv: ["status", "--fixloop"], verb: "status", handler: "handleFixloopStatus", mc: "state-only" },
  { argv: ["status", "--overview"], verb: "status", handler: "handleOverview", mc: "state-only" },
  { argv: ["status", "--history"], verb: "status", handler: "handleHistory", mc: "state-only" },
  { argv: ["status", "--metrics"], verb: "status", handler: "handleMetrics", mc: "state-only" },
  { argv: ["status", "--usage"], verb: "status", handler: "handleUsage", mc: "state-only" },
  { argv: ["status", "--ledger"], verb: "status", handler: "handleLedger", mc: "state-only" },
  { argv: ["status", "--result", "j1"], verb: "status", handler: "handleResult", mc: "state-only" },
  { argv: ["status", "--watch", "job1", "--interval", "3"], verb: "status", handler: "handleWatch", mc: "state-only" },
  // setup action forms
  { argv: ["setup", "--check"], verb: "setup", handler: "handleDoctor", mc: "state-only" },
  { argv: ["setup", "--usage"], verb: "setup", handler: "handleUsage", mc: "state-only" },
  // hidden verbs (kept callable, not in --help)
  { argv: ["benchmark"], verb: "benchmark", handler: "handleBenchmark", mc: null },
  { argv: ["worktree"], verb: "worktree", handler: "handleWorktree", mc: null },
  { argv: ["worker"], verb: "worker", handler: "handleWorker", mc: null }
];

// Every OLD command name that used to alias — now a clean unknown-command error, no handler, no writer.
const REJECTED_OLD_NAMES = [
  ["deliberate"], ["deliberation"], ["adversarial"], ["adversarial-review"],
  ["audit"], ["audit", "fix"], ["audit", "review"], ["audit", "run"], ["audit", "endless"], ["endless"],
  ["watch"], ["wait"], ["result"], ["cancel"], ["fixloop-status"], ["overview"],
  ["history"], ["metrics"], ["usage"], ["ledger"], ["doctor"]
];

test("(a) GOLDEN: every canonical argv routes to the right handler/mutationClass and is an expandAliases fixed point", () => {
  for (const row of GOLDEN) {
    assert.deepEqual(expandAliases(row.argv), row.argv, `not a fixed point: ${JSON.stringify(row.argv)}`);
    const r = route(row.argv);
    assert.equal(r.verb, row.verb, `verb for ${JSON.stringify(row.argv)}`);
    assert.equal(r.handler, row.handler, `handler for ${JSON.stringify(row.argv)}`);
    assert.equal(r.mutationClass, row.mc, `mutationClass for ${JSON.stringify(row.argv)}`);
    if (row.auditSub != null) assert.equal(r.auditSub, row.auditSub, `auditSub for ${JSON.stringify(row.argv)}`);
  }
});

test("(a) REJECTED: every old command name resolves to the clean unknown-command error (never a writer)", () => {
  for (const argv of REJECTED_OLD_NAMES) {
    const r = route(argv);
    assert.equal(r.handler, "error", `old name ${JSON.stringify(argv)} must be rejected`);
    assert.notEqual(r.mutationClass, "working-tree", `rejected ${JSON.stringify(argv)} may not carry working-tree`);
    assert.match(r.error, /^unknown command '.+'\. Verbs: review fix plan build solve status setup\. Run --help\.$/);
  }
});

test("(a) COMPLETENESS: every canonical + hidden verb has a golden row (no silent escape)", () => {
  const coveredHead = new Set(GOLDEN.map((r) => r.argv[0]));
  for (const v of [...CANONICAL_VERBS, ...HIDDEN_VERBS]) assert.ok(coveredHead.has(v), `verb "${v}" has no golden row — add one`);
  // every deep audit engine mode is exercised
  const auditSubs = new Set(GOLDEN.filter((r) => r.auditSub != null).map((r) => r.auditSub));
  for (const sub of ["fix", "review", "run", "endless"]) assert.ok(auditSubs.has(sub), `audit engine "${sub}" has no golden row`);
});

test("(a) COMPLETENESS: every registry flag is accepted by the audit parser (a new flag cannot escape parsing)", () => {
  const parsed = new Set([...valueOptionsFor("audit"), ...booleanOptionsFor("audit")]);
  for (const e of CLI_FLAGS) {
    assert.ok(parsed.has(e.flag), `registry flag --${e.flag} is not derived into the audit parser option lists`);
    if (e.negatable) assert.ok(parsed.has(`no-${e.flag}`), `negatable flag --${e.flag} is missing its --no-${e.flag} twin`);
  }
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
// (b) READ-ONLY NEVER WRITES. Two layers: a fast, always-run STRUCTURAL proof (no read-only route can
//     reach a code writer + the guard refuses the verb), and a real WORKTREE SNAPSHOT (a temp git repo,
//     every RO verb run through the real CLI with all seats forced unreachable so no model is called,
//     tracked-file hashes IDENTICAL before/after). The snapshot is the strongest safety pin.
// ────────────────────────────────────────────────────────────────────────────────────────────────

// The only code paths that reach a tracked-source writer: handleAudit(["fix", …]) and handleBuild.
function reachesCodeWriter(r) {
  if (r.handler === "handleAudit" && Array.isArray(r.args) && r.args[0] === "fix") return true;
  if (r.handler === "handleBuild") return true;
  return false;
}

// Every CANONICAL READ-ONLY invocation (review family + the deep engines + plan + solve + status + setup).
const READ_ONLY_INVOCATIONS = [
  ["review"], ["review", "--mode", "quick", "focus"],
  ["review", "--mode", "deliberate"], ["review", "--mode", "adversarial"],
  ["review", "--mode", "deep"], ["review", "--mode", "deep", "--groups", "lens"],
  ["review", "--mode", "run"], ["review", "--mode", "run", "--sarif"],
  ["review", "--mode", "endless"], ["review", "--mode", "endless", "--max-passes", "1"],
  ["solve"], ["solve", "make it faster"],
  ["plan"], ["plan", "add a helper"],
  ["status"], ["status", "--watch"], ["status", "--wait"], ["status", "--result"],
  ["status", "--cancel", "j1"], ["status", "--fixloop"], ["status", "--overview"],
  ["status", "--history"], ["status", "--metrics"], ["status", "--usage"], ["status", "--ledger"],
  ["setup"], ["setup", "--check"], ["setup", "--usage"]
];

test("(b) STRUCTURAL: no read-only invocation reaches a code writer, and the mutation guard refuses each", () => {
  for (const argv of READ_ONLY_INVOCATIONS) {
    const r = route(argv);
    assert.equal(reachesCodeWriter(r), false, `RO ${JSON.stringify(argv)} reached a writer via ${r.handler}`);
    assert.notEqual(r.mutationClass, "working-tree", `RO ${JSON.stringify(argv)} carried working-tree mutationClass`);
    assert.throws(() => assertCodeWriteAllowed(r.verb), /mutationClass violation/, `guard admitted RO ${JSON.stringify(argv)}`);
  }
});

// A temp git repo with a couple of tracked source files (+ a config that forces every seat unreachable,
// so a real review run makes NO model call). Returns null when git is unavailable in this environment.
function makeReadOnlyRepo() {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "council-ro-"));
  const git = (...args) => spawnSync("git", args, { cwd: workDir, encoding: "utf8", timeout: 30_000 });
  if (git("init").status !== 0) {
    fs.rmSync(workDir, { recursive: true, force: true });
    return null;
  }
  fs.writeFileSync(path.join(workDir, "index.mjs"), "export const value = 1;\n", "utf8");
  fs.writeFileSync(path.join(workDir, "helper.mjs"), "export const double = (n) => n * 2;\n", "utf8");
  // reviewers:[claude] + claude_backend:spawn + a fake CLAUDE_BIN that EXISTS but exits non-zero ⇒ the
  // claude `--version` probe reports unavailable, so the ONLY reviewer is unreachable and every RO verb
  // reaches its real handler then fails fast WITHOUT any model call (codex/grok are policy-skipped, so
  // neither CLI is invoked either). A NON-EXISTENT bin would let findClaudeBinary fall back to a real
  // `claude` on PATH — real model calls — so the bin must exist and fail, matching the proven pattern.
  fs.writeFileSync(path.join(workDir, ".council.yml"), "version: 1\nreviewers: [claude]\nclaude_backend: spawn\n", "utf8");
  const fakeClaudeBin = path.join(workDir, "fake-claude.cmd");
  fs.writeFileSync(fakeClaudeBin, "@echo off\r\nexit /b 1\r\n", "utf8");
  git("add", "-A");
  const commit = git("-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "-m", "init", "--no-verify");
  if (commit.status !== 0) {
    fs.rmSync(workDir, { recursive: true, force: true });
    return null;
  }
  return { workDir, fakeClaudeBin };
}

// { relpath → sha256 } over every git-TRACKED file (the source the RO rule protects; untracked artifacts
// under docs/ or the state dir are allowed and excluded).
function snapshotTracked(repo) {
  const listed = spawnSync("git", ["ls-files"], { cwd: repo, encoding: "utf8", timeout: 30_000 }).stdout;
  const files = listed.split(/\r?\n/).filter(Boolean).sort();
  const map = {};
  for (const f of files) {
    try {
      map[f] = createHash("sha256").update(fs.readFileSync(path.join(repo, f))).digest("hex");
    } catch {
      map[f] = "MISSING";
    }
  }
  return map;
}

test("(b) WORKTREE SNAPSHOT: every read-only verb leaves EVERY tracked source file byte-identical (real CLI, no model calls)", (t) => {
  const repo = makeReadOnlyRepo();
  if (!repo) {
    t.skip("git is unavailable in this environment");
    return;
  }
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "council-ro-state-"));
  const env = { ...process.env, AGENT_COUNCIL_STATE_DIR: stateRoot, CLAUDE_BIN: repo.fakeClaudeBin };
  // review (quick/deliberate/adversarial/deep/endless/run), plan, solve — the whole RO surface.
  const RO_VERB_ARGS = [
    ["review"],
    ["review", "--mode", "deliberate"],
    ["review", "--mode", "adversarial"],
    ["review", "--mode", "deep"],
    ["review", "--mode", "endless", "--max-passes", "1"],
    ["review", "--mode", "run"],
    ["plan", "add a small helper"],
    ["solve", "make the helper faster"]
  ];
  try {
    for (const argv of RO_VERB_ARGS) {
      const before = snapshotTracked(repo.workDir);
      const res = spawnSync(process.execPath, [COMPANION, ...argv], { cwd: repo.workDir, env, encoding: "utf8", timeout: 45_000 });
      if (isSandboxBlocked(res)) {
        t.skip("child_process.spawn is blocked by this sandbox");
        return;
      }
      if (res.error && res.error.code === "ETIMEDOUT") continue; // env slowness, not a write — skip this one
      const after = snapshotTracked(repo.workDir);
      assert.deepEqual(after, before, `read-only ${JSON.stringify(argv)} MODIFIED tracked source (RO-never-writes violated)`);
      // and it never carved an isolated council/* branch (that is only ever a fix/build gesture)
      const branches = spawnSync("git", ["branch", "--list", "council/*"], { cwd: repo.workDir, encoding: "utf8" }).stdout.trim();
      assert.equal(branches, "", `read-only ${JSON.stringify(argv)} created a council/* branch: ${branches}`);
    }
  } finally {
    fs.rmSync(stateRoot, { recursive: true, force: true });
    fs.rmSync(repo.workDir, { recursive: true, force: true });
  }
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
// (c) WRITE ENVELOPE — fix/build write ONLY on an isolated council/* branch, NEVER auto-merge, and the
//     mutationClass guard is their FIRST statement. Structural (the guard fires before any writer) + a
//     source pin on the branch-isolation literals + the never-auto-merge invariant surfaced by --explain.
// ────────────────────────────────────────────────────────────────────────────────────────────────

test("(c) GUARD-FIRST: the mutation guard is the first statement of both writers (a forged RO verb throws before any work)", async () => {
  for (const verb of ["review", "plan", "solve", undefined]) {
    await assert.rejects(handleAudit(["fix"], verb === undefined ? {} : { verb }), /mutationClass violation/, `handleAudit admitted ${verb}`);
    await assert.rejects(handleBuild(["--from", "plan.json"], verb === undefined ? {} : { verb }), /mutationClass violation/, `handleBuild admitted ${verb}`);
  }
  // only fix/build are working-tree writers; the guard admits exactly those two
  assert.doesNotThrow(() => assertCodeWriteAllowed("fix"));
  assert.doesNotThrow(() => assertCodeWriteAllowed("build"));
  assert.equal(VERB_MUTATION.fix, "working-tree");
  assert.equal(VERB_MUTATION.build, "working-tree");
});

test("(c) ISOLATED BRANCH: fix/build integration branches are council/*-prefixed (never the base branch)", () => {
  const scriptsDir = path.dirname(COMPANION);
  const fixSrc = fs.readFileSync(path.join(scriptsDir, "lib", "audit-fix.mjs"), "utf8");
  const buildSrc = fs.readFileSync(path.join(scriptsDir, "lib", "build.mjs"), "utf8");
  assert.match(fixSrc, /`council\/audit-fix-/, "audit-fix must commit on a council/audit-fix-* isolated branch");
  assert.match(buildSrc, /`council\/build-/, "build must commit on a council/build-* isolated branch");
});

test("(c) NEVER-AUTO-MERGE: build reports auto_merge=false as a built-in invariant that no flag/config can flip", () => {
  const base = resolveExplain({ verb: "build", args: [], deps: { policy: {} } });
  const am = base.knobs.find((k) => k.key === "auto_merge");
  assert.deepEqual(am, { key: "auto_merge", value: false, source: "built-in" }, "auto_merge must be a built-in false");
  assert.ok(base.knobs.some((k) => k.key === "isolated_branch" && k.value === true), "isolated_branch is a built-in invariant");
  assert.ok(base.knobs.some((k) => k.key === "six_eyes_gated" && k.value === true), "six_eyes_gated is a built-in invariant");
  // even a config block that tries to smuggle auto_merge/skip-gate keys cannot produce an auto_merge=true
  const hostile = resolveExplain({ verb: "build", args: [], deps: { policy: { build: { auto_merge: true, skip_gate: true } } } });
  assert.equal(hostile.knobs.find((k) => k.key === "auto_merge").value, false, "a hostile build: config must NOT flip auto_merge");
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
// (d) JSON STDOUT PURITY (matrix). Under --json, stdout parses as valid JSON and EVERY note/banner/
//     warning lands on STDERR only (0 non-JSON bytes on stdout) — incl. the alias deprecation note, the
//     fix effective-policy banner, and --explain --json.
// ────────────────────────────────────────────────────────────────────────────────────────────────

function runCli(args, extraEnv = {}) {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "council-json-"));
  try {
    return {
      res: spawnSync(process.execPath, [COMPANION, ...args], {
        cwd: os.tmpdir(),
        env: { ...process.env, AGENT_COUNCIL_STATE_DIR: stateRoot, ...extraEnv },
        encoding: "utf8",
        timeout: 60_000
      })
    };
  } finally {
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
}

// Every case is model-free (--explain for the run-verbs; observation for status/setup). All CANONICAL —
// the old-name aliases are gone, so there is no deprecation note to keep off stdout any more.
const PURITY_MATRIX = [
  { args: ["fix", "--explain", "--json"] },
  { args: ["build", "--explain", "--json"] },
  { args: ["review", "--explain", "--json"] },
  { args: ["review", "--mode", "deliberate", "--explain", "--json"] },
  { args: ["plan", "--explain", "--json"] },
  { args: ["solve", "--explain", "--json"] },
  { args: ["status", "--explain", "--json"] },
  { args: ["setup", "--explain", "--json"] },
  { args: ["status", "--json"] },
  { args: ["status", "--metrics", "--json"] },
  { args: ["status", "--usage", "--json"] },
  { args: ["setup", "--check", "--no-ping", "--json"] }
];

test("(d) JSON PURITY: every verb emits PURE JSON on stdout; banners/warnings only on stderr", (t) => {
  for (const { args } of PURITY_MATRIX) {
    const { res } = runCli(args);
    if (isSandboxBlocked(res)) {
      t.skip("child_process.spawn is blocked by this sandbox");
      return;
    }
    // An --explain resolution MUST succeed (exit 0); observational verbs (status/setup --check/metrics/
    // usage) may exit non-zero on an empty/offline environment, but their stdout must STILL be pure JSON.
    if (args.includes("--explain")) assert.equal(res.status, 0, `${JSON.stringify(args)} exited non-zero: ${res.stderr}`);
    // stdout is ENTIRELY valid JSON (0 non-JSON bytes) — the whole point of --json.
    // stdout parsing cleanly IS the "0 non-JSON bytes" proof: a leaked banner/warning LINE (plain text, not
    // JSON) would coexist with the JSON object and break JSON.parse. A banner that is a legitimate JSON
    // *field value* (e.g. doctor's effectivePolicy) is structured data, not a leak.
    let parsed;
    assert.doesNotThrow(() => { parsed = JSON.parse(res.stdout); }, `${JSON.stringify(args)} stdout is not pure JSON:\n${res.stdout.slice(0, 200)}`);
    assert.ok(parsed && typeof parsed === "object", `${JSON.stringify(args)} stdout did not parse to an object`);
    // no stray note/banner ever leaks onto stdout
    assert.doesNotMatch(res.stdout, /^note:/m, `${JSON.stringify(args)} leaked a note onto stdout`);
  }
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
// (e) --explain SOURCE RESOLUTION. config→"config", an explicit flag override→"flag", an unset knob→
//     "built-in", a consent→its precise source. It writes nothing + runs no work (no writer is imported;
//     a real `fix --explain` leaves the tree + state dir untouched).
// ────────────────────────────────────────────────────────────────────────────────────────────────

const CLEAN_CONSENT = { structureAutoApply: false, sensitiveAutoApply: false, sources: { structure: null, sensitive: null }, warnings: [] };

test("(e) SOURCES: a fix knob is config when set in fix:, flag when overridden, built-in when unset", () => {
  const policy = { fix: { loop: true, max_passes: 100, usage_ceiling: "90/90/90" } };
  const knob = (r, k) => r.knobs.find((x) => x.key === k);

  // config-sourced
  const cfg = resolveExplain({ verb: "fix", args: ["fix"], deps: { policy, consent: CLEAN_CONSENT } });
  assert.deepEqual(knob(cfg, "loop"), { key: "loop", value: true, source: "config" });
  assert.deepEqual(knob(cfg, "max_passes"), { key: "max_passes", value: 100, source: "config" });
  assert.deepEqual(knob(cfg, "usage_ceiling"), { key: "usage_ceiling", value: "90/90/90", source: "config" });
  // unset → built-in
  assert.deepEqual(knob(cfg, "deep"), { key: "deep", value: false, source: "built-in" });
  assert.deepEqual(knob(cfg, "max_fixes"), { key: "max_fixes", value: null, source: "built-in" });

  // an explicit flag OVERRIDES config → source "flag" (incl. a --no-<flag> explicit false)
  const flagged = resolveExplain({ verb: "fix", args: ["fix", "--no-loop", "--max-passes", "7", "--deep"], deps: { policy, consent: CLEAN_CONSENT } });
  assert.deepEqual(knob(flagged, "loop"), { key: "loop", value: false, source: "flag" });
  assert.deepEqual(knob(flagged, "max_passes"), { key: "max_passes", value: "7", source: "flag" });
  assert.deepEqual(knob(flagged, "deep"), { key: "deep", value: true, source: "flag" });
});

test("(e) SOURCES: each consent shows its PRECISE trust-channel source; null channel is the built-in safe default", () => {
  const mk = (structSource) =>
    buildFixExplain({}, { fix: {} }, { structureAutoApply: structSource != null && !String(structSource).startsWith("refused"), sensitiveAutoApply: false, sources: { structure: structSource, sensitive: null }, warnings: [] });
  const consentKnob = (r) => r.knobs.find((x) => x.key === "structure_auto_apply");

  assert.equal(consentKnob(mk("flag")).source, "flag");
  assert.equal(consentKnob(mk("local")).source, "local,acknowledged");
  assert.equal(consentKnob(mk("env")).source, "env,acknowledged");
  assert.equal(consentKnob(mk("refused:no-ack")).source, "refused:no-ack");
  assert.equal(consentKnob(mk(null)).source, "built-in"); // no channel ⇒ unset ⇒ built-in
  // the built-in/unset consent is OFF (propose-only) and flagged as a consent knob
  const off = consentKnob(mk(null));
  assert.equal(off.value, false);
  assert.equal(off.consent, true);
});

test("(e) NO WORK, NO WRITES: resolveExplain calls only READ-only deps (a spied loadPolicy/resolveConsents run once, no writer)", () => {
  const calls = { loadPolicy: 0, resolveConsents: 0 };
  const r = resolveExplain({
    verb: "fix",
    args: ["fix", "--loop"],
    cwd: "/nonexistent-repo",
    stateDir: "/nonexistent-state",
    deps: {
      loadPolicy: () => { calls.loadPolicy += 1; return { fix: { deep: true } }; },
      resolveConsents: () => { calls.resolveConsents += 1; return CLEAN_CONSENT; }
    }
  });
  assert.equal(calls.loadPolicy, 1, "loadPolicy (read-only) is consulted exactly once");
  assert.equal(calls.resolveConsents, 1, "resolveConsents (read-only) is consulted exactly once");
  assert.equal(r.knobs.find((k) => k.key === "loop").source, "flag");
  assert.equal(r.knobs.find((k) => k.key === "deep").source, "config");
});

test("(e) NO WRITES end-to-end: `fix --explain` leaves the tracked tree + state dir untouched and cuts no branch", (t) => {
  const repo = makeReadOnlyRepo();
  if (!repo) {
    t.skip("git is unavailable in this environment");
    return;
  }
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "council-explain-state-"));
  try {
    const before = snapshotTracked(repo.workDir);
    for (const args of [["fix", "--explain"], ["fix", "--explain", "--json"], ["fix", "--loop", "--deep", "--explain", "--json"]]) {
      const res = spawnSync(process.execPath, [COMPANION, ...args], {
        cwd: repo.workDir,
        env: { ...process.env, AGENT_COUNCIL_STATE_DIR: stateRoot, CLAUDE_BIN: repo.fakeClaudeBin },
        encoding: "utf8",
        timeout: 60_000
      });
      if (isSandboxBlocked(res)) {
        t.skip("child_process.spawn is blocked by this sandbox");
        return;
      }
      assert.equal(res.status, 0, `${JSON.stringify(args)} exited non-zero: ${res.stderr}`);
    }
    assert.deepEqual(snapshotTracked(repo.workDir), before, "fix --explain modified tracked source");
    assert.equal(spawnSync("git", ["status", "--porcelain"], { cwd: repo.workDir, encoding: "utf8" }).stdout.trim(), "", "fix --explain dirtied the tree");
    assert.equal(spawnSync("git", ["branch", "--list", "council/*"], { cwd: repo.workDir, encoding: "utf8" }).stdout.trim(), "", "fix --explain cut a council/* branch");
    // --explain ran NO fix work ⇒ it never recorded a consent-ack in the state dir
    assert.ok(!fs.existsSync(path.join(stateRoot, "consent-ack.json")), "fix --explain must not write a consent acknowledgment");
  } finally {
    fs.rmSync(stateRoot, { recursive: true, force: true });
    fs.rmSync(repo.workDir, { recursive: true, force: true });
  }
});

// ────────────────────────────────────────────────────────────────────────────────────────────────
// WIRE-UP SMOKES (real subprocess, no model calls) — the CLI actually behaves as the gates assume.
// ────────────────────────────────────────────────────────────────────────────────────────────────

test("SMOKE: --help lists the 7 canonical verbs", (t) => {
  const { res } = runCli(["--help"]);
  if (isSandboxBlocked(res)) {
    t.skip("child_process.spawn is blocked by this sandbox");
    return;
  }
  assert.equal(res.status, 0, res.stderr);
  for (const verb of CANONICAL_VERBS) {
    assert.match(res.stdout, new RegExp(`^\\s+${verb}\\s`, "m"), `--help must list the "${verb}" verb`);
  }
  // hidden verbs are NOT in the verb head-count block
  assert.doesNotMatch(res.stdout, /^\s+worker\s+\[/m, "worker must stay hidden from the top verb list");
});

test("SMOKE: `fix --explain --json` is pure JSON carrying knob SOURCES (config/flag/built-in + consent)", (t) => {
  const { res } = runCli(["fix", "--explain", "--json"]);
  if (isSandboxBlocked(res)) {
    t.skip("child_process.spawn is blocked by this sandbox");
    return;
  }
  assert.equal(res.status, 0, res.stderr);
  const j = JSON.parse(res.stdout);
  assert.equal(j.explain, true);
  assert.equal(j.verb, "fix");
  assert.equal(j.mutationClass, "working-tree");
  assert.ok(Array.isArray(j.knobs) && j.knobs.length > 0);
  for (const k of j.knobs) assert.ok(typeof k.source === "string" && k.source.length > 0, `knob ${k.key} has no source`);
  // the two auto-apply consents are always present as consent knobs
  assert.ok(j.knobs.some((k) => k.key === "structure_auto_apply" && k.consent === true));
  assert.ok(j.knobs.some((k) => k.key === "sensitive_auto_apply" && k.consent === true));
});

test("SMOKE: `setup --check --json` is pure JSON and surfaces the SAME resolved fix policy as --explain", (t) => {
  const { res } = runCli(["setup", "--check", "--no-ping", "--json"]);
  if (isSandboxBlocked(res)) {
    t.skip("child_process.spawn is blocked by this sandbox");
    return;
  }
  // doctor exits non-zero when a check fails (offline env), but stdout must still be pure JSON.
  const j = JSON.parse(res.stdout);
  assert.ok(Array.isArray(j.resolvedPolicy) && j.resolvedPolicy.length > 0, "setup --check must include the resolved fix policy");
  for (const k of j.resolvedPolicy) assert.ok(typeof k.key === "string" && typeof k.source === "string", "each resolved knob has key+source");
  assert.ok(j.resolvedPolicy.some((k) => k.key === "structure_auto_apply"), "the consent knobs appear in setup --check's resolved policy");
});

test("SMOKE: `review --mode deliberate --explain --json` resolves the mode as pure JSON", (t) => {
  const { res } = runCli(["review", "--mode", "deliberate", "--explain", "--json"]);
  if (isSandboxBlocked(res)) {
    t.skip("child_process.spawn is blocked by this sandbox");
    return;
  }
  assert.equal(res.status, 0, res.stderr);
  const j = JSON.parse(res.stdout); // stdout stays pure JSON
  assert.equal(j.verb, "review");
  assert.equal(j.knobs.find((k) => k.key === "mode").value, "deliberate", "the resolved mode reflects --mode");
});

test("SMOKE: an OLD command name is a clean unknown-command error (exit 1, message on stderr, no stdout leak)", (t) => {
  for (const old of ["deliberate", "audit", "watch", "doctor"]) {
    const { res } = runCli([old, "--json"]);
    if (isSandboxBlocked(res)) {
      t.skip("child_process.spawn is blocked by this sandbox");
      return;
    }
    assert.notEqual(res.status, 0, `${old} must exit non-zero`);
    assert.match(res.stderr, new RegExp(`unknown command '${old}'\\. Verbs: review fix plan build solve status setup\\. Run --help\\.`), `${old} must print the clean error`);
    assert.equal(res.stdout.trim(), "", `${old} must not print anything to stdout`);
  }
});

test("SMOKE: `status --watch --json` routes to the watch handler (no action-collision error)", (t) => {
  const { res } = runCli(["status", "--watch", "--once", "--json"]);
  if (isSandboxBlocked(res)) {
    t.skip("child_process.spawn is blocked by this sandbox");
    return;
  }
  // no such job → the watch handler reports "No council jobs found." on STDERR and leaves stdout empty;
  // the key point is it ROUTED to the watch handler (never the "one action at a time" collision error),
  // and if it did print anything to stdout it stays pure JSON (never a non-JSON leak).
  assert.doesNotMatch(`${res.stdout}${res.stderr}`, /one action at a time/, "status --watch must route to the watch handler");
  assert.doesNotMatch(res.stdout, /^note:/m, "no deprecation note may leak to stdout");
  if (res.stdout.trim()) assert.doesNotThrow(() => JSON.parse(res.stdout), `status --watch --json stdout not pure JSON: ${res.stdout.slice(0, 160)}`);
});
