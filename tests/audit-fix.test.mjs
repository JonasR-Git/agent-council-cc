import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildFixWriteArgs,
  classifyFixable,
  enforceTouched,
  ineligibleReason,
  parsePorcelainZ,
  runAuditFix,
  scheduleFixes,
  toPosix
} from "../plugins/council/scripts/lib/audit-fix.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "council-fix-"));

// --- eligibility (fail-closed) ----------------------------------------------

test("ineligibleReason is fail-closed: needs explicit localized scope + safe file + severity", () => {
  assert.equal(ineligibleReason({ severity: "P1", scope: "localized", file: "a.mjs" }), null);
  assert.match(ineligibleReason({ severity: "P1", scope: "cross-cutting", file: "a.mjs" }), /cross-cutting/);
  assert.match(ineligibleReason({ severity: "P1", file: "a.mjs" }), /fail-closed/, "missing scope is rejected, not fixed");
  assert.match(ineligibleReason({ severity: "P1", scope: "localish", file: "a.mjs" }), /fail-closed/);
  assert.match(ineligibleReason({ severity: "P1", scope: "localized" }), /no target file/);
  assert.match(ineligibleReason({ severity: "P1", scope: "localized", file: "../etc/passwd" }), /unsafe file path/);
  assert.match(ineligibleReason({ severity: "P1", scope: "localized", file: "C:\\Windows\\x" }), /unsafe file path/);
  assert.match(ineligibleReason({ severity: "nit", scope: "localized", file: "a.mjs" }), /severity gate/);
});

test("PROTECTED_RE blocks secrets/CI/infra AND matches Windows separators", () => {
  for (const file of ["node_modules/x/i.mjs", ".git/config", "dist/b.js", ".env", ".env.production", ".github/workflows/ci.yml", "Dockerfile", "secrets/key.pem", "config/id.key"]) {
    assert.match(ineligibleReason({ severity: "P1", scope: "localized", file }), /protected/, `posix ${file} protected`);
  }
  // Windows-separator variants must ALSO be caught (normalized before matching).
  assert.match(ineligibleReason({ severity: "P1", scope: "localized", file: "node_modules\\pkg\\i.mjs" }), /protected/);
  assert.match(ineligibleReason({ severity: "P1", scope: "localized", file: ".github\\workflows\\ci.yml" }), /protected/);
});

test("classifyFixable splits eligible vs rejected with reasons", () => {
  const { eligible, rejected } = classifyFixable([
    { severity: "P1", scope: "localized", file: "a.mjs", title: "ok" },
    { severity: "P2", scope: "cross-cutting", file: "b.mjs", title: "ssot" },
    { severity: "P0", scope: "localized", file: "dist/bundle.js", title: "built" },
    { severity: "P1", file: "c.mjs", title: "no-scope" }
  ]);
  assert.deepEqual(eligible.map((f) => f.file), ["a.mjs"]);
  assert.equal(rejected.length, 3);
});

// --- scheduling + guard + parsing -------------------------------------------

test("scheduleFixes groups by posix file (one writer/file), worst-first, serialized within", () => {
  const tasks = scheduleFixes([
    { severity: "P2", file: "a.mjs", title: "a-p2" },
    { severity: "P1", file: "b.mjs", title: "b-p1" },
    { severity: "P0", file: "a.mjs", title: "a-p0" }
  ]);
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].file, "a.mjs");
  assert.deepEqual(tasks[0].findings.map((f) => f.severity), ["P0", "P2"]);
});

test("scheduleFixes treats backslash and forward-slash paths as ONE file", () => {
  const tasks = scheduleFixes([
    { severity: "P1", file: "src\\a.mjs", title: "win" },
    { severity: "P2", file: "src/a.mjs", title: "posix" }
  ]);
  assert.equal(tasks.length, 1, "same physical file must not split into two tasks");
});

test("enforceTouched normalizes separators before comparing", () => {
  assert.deepEqual(enforceTouched(["a.mjs"], "a.mjs"), { ok: true, violations: [] });
  assert.deepEqual(enforceTouched(["src/a.mjs"], "src\\a.mjs"), { ok: true, violations: [] });
  assert.equal(enforceTouched(["a.mjs", "b.mjs"], "a.mjs").ok, false);
});

test("parsePorcelainZ handles plain edits and rename/copy pairs", () => {
  assert.deepEqual(parsePorcelainZ(" M a.mjs\0"), ["a.mjs"]);
  // a rename emits `R  new\0old\0`; BOTH paths must surface so a rename off the
  // target is caught as a violation (fail-closed).
  assert.deepEqual(parsePorcelainZ("R  new.mjs\0old.mjs\0"), ["old.mjs", "new.mjs"]);
  assert.deepEqual(parsePorcelainZ("?? x.mjs\0 M y.mjs\0"), ["x.mjs", "y.mjs"]);
});

test("toPosix strips backslashes and ./ prefix", () => {
  assert.equal(toPosix("a\\b\\c.mjs"), "a/b/c.mjs");
  assert.equal(toPosix("./a.mjs"), "a.mjs");
});

test("buildFixWriteArgs enables edit tools but denies exec/network, non-interactively", () => {
  const args = buildFixWriteArgs({ claudeModel: "claude-opus-4-8" });
  assert.ok(args.includes("Edit") && args.includes("Write"));
  assert.ok(args.indexOf("Bash") > args.indexOf("--disallowed-tools"), "Bash only in the deny list");
  assert.ok(args.includes("--strict-mcp-config"));
  assert.equal(args[args.indexOf("--permission-mode") + 1], "acceptEdits");
  assert.equal(args[args.indexOf("--model") + 1], "claude-opus-4-8");
});

// --- full orchestration with injected adapters -------------------------------

function fakeGit({ clean = true, repo = true } = {}) {
  const calls = [];
  let head = "base0000ffffffff";
  let changed = [];
  return {
    calls,
    setChanged(c) {
      changed = c;
    },
    isRepo: () => repo,
    isClean: () => clean,
    head: () => head,
    currentBranch: () => "master",
    createAndCheckout: (b, ref) => calls.push(["createAndCheckout", b, ref]),
    checkout: (r) => (calls.push(["checkout", r]), true),
    changedFiles: () => changed,
    resetHard: (ref) => {
      calls.push(["resetHard", ref]);
      changed = [];
    },
    commitFile: (file, msg) => {
      calls.push(["commitFile", file, msg]);
      head = `commit${calls.length}`;
      changed = [];
      return head;
    }
  };
}

const baseDeps = (git, over = {}) => ({
  git,
  fileExists: () => true,
  readFile: () => "export const x = 1;\n",
  testCmd: { cmd: "true", args: [] },
  runTests: async () => ({ ok: true }),
  ...over
});

const loc = (o) => ({ severity: "P1", scope: "localized", ...o });

test("runAuditFix commits a fix when the edit is in-scope and tests pass", async () => {
  const git = fakeGit();
  const out = await runAuditFix(tmp(), [loc({ file: "a.mjs", title: "fix me" })], {}, {}, baseDeps(git, { applyFix: async () => git.setChanged(["a.mjs"]) }));
  assert.equal(out.ok, true);
  assert.equal(out.fixed.length, 1);
  assert.equal(out.fixed[0].verified, true);
  assert.ok(git.calls.some((c) => c[0] === "commitFile" && c[1] === "a.mjs"), "staged only the target file");
  assert.match(out.branch, /^council\/audit-fix-base0000/);
});

test("runAuditFix reverts + rejects an out-of-scope edit; never commits", async () => {
  const git = fakeGit();
  const out = await runAuditFix(tmp(), [loc({ file: "a.mjs", title: "fix" })], {}, {}, baseDeps(git, { applyFix: async () => git.setChanged(["a.mjs", "sneaky.mjs"]) }));
  assert.equal(out.fixed.length, 0);
  assert.match(out.rejected[0].reason, /outside target/);
  assert.ok(git.calls.some((c) => c[0] === "resetHard"));
  assert.ok(!git.calls.some((c) => c[0] === "commitFile"));
});

test("runAuditFix reverts + fails a fix when tests go red", async () => {
  const git = fakeGit();
  const out = await runAuditFix(tmp(), [loc({ file: "a.mjs", title: "fix" })], {}, {}, baseDeps(git, { applyFix: async () => git.setChanged(["a.mjs"]), runTests: async () => ({ ok: false, output: "1 failing" }) }));
  assert.equal(out.fixed.length, 0);
  assert.match(out.failed[0].reason, /tests failed/);
  assert.ok(git.calls.some((c) => c[0] === "resetHard"));
});

test("runAuditFix reverts + fails when the write runner throws", async () => {
  const git = fakeGit();
  const out = await runAuditFix(tmp(), [loc({ file: "a.mjs", title: "fix" })], {}, {}, baseDeps(git, { applyFix: async () => { throw new Error("runner exploded"); } }));
  assert.equal(out.fixed.length, 0);
  assert.match(out.failed[0].reason, /runner exploded/);
  assert.ok(git.calls.some((c) => c[0] === "resetHard"));
});

test("runAuditFix skips a finding the agent leaves unchanged", async () => {
  const git = fakeGit();
  const out = await runAuditFix(tmp(), [loc({ file: "a.mjs", title: "noop" })], {}, {}, baseDeps(git, { applyFix: async () => git.setChanged([]) }));
  assert.equal(out.skipped.length, 1);
  assert.equal(out.fixed.length, 0);
});

test("runAuditFix: a RED final integration run reports ok:false, base still returned", async () => {
  const git = fakeGit();
  let n = 0;
  const out = await runAuditFix(tmp(), [loc({ file: "a.mjs", title: "fix" })], {}, {}, baseDeps(git, {
    applyFix: async () => git.setChanged(["a.mjs"]),
    runTests: async () => ({ ok: ++n === 1 }) // per-fix gate green, final integration red
  }));
  assert.equal(out.fixed.length, 1, "the fix committed under its green per-fix gate");
  assert.equal(out.integrationFailed, true);
  assert.equal(out.ok, false, "a red integration run is NOT reported as success");
  assert.ok(git.calls.some((c) => c[0] === "checkout" && c[1] === "master"), "returned to base");
});

test("runAuditFix: same-file second-fix failure reverts to the FIRST fix's commit, keeping it", async () => {
  const git = fakeGit();
  let n = 0;
  const out = await runAuditFix(
    tmp(),
    [loc({ severity: "P1", file: "a.mjs", title: "first" }), loc({ severity: "P2", file: "a.mjs", title: "second" })],
    {},
    {},
    baseDeps(git, {
      applyFix: async () => git.setChanged(["a.mjs"]),
      // gate calls: 1=first(ok) 2=second(red) ; final integration=3(ok)
      runTests: async () => ({ ok: ++n !== 2 })
    })
  );
  assert.equal(out.fixed.length, 1, "first fix kept");
  assert.equal(out.fixed[0].finding.title, "first");
  assert.equal(out.failed.length, 1, "second fix failed");
  const commitSha = git.calls.find((c) => c[0] === "commitFile")[2] ? null : null; // (sha captured below)
  const firstCommit = out.fixed[0].commit;
  const resets = git.calls.filter((c) => c[0] === "resetHard").map((c) => c[1]);
  assert.ok(resets.includes(firstCommit), "second failure reset to the first fix's commit, not to base");
  void commitSha;
});

test("runAuditFix refuses without git, on a dirty tree, and without a test gate", async () => {
  const noRepo = await runAuditFix(tmp(), [], {}, {}, baseDeps(fakeGit({ repo: false })));
  assert.match(noRepo.error, /not a git repository/);
  const dirty = await runAuditFix(tmp(), [], {}, {}, baseDeps(fakeGit({ clean: false })));
  assert.match(dirty.error, /not clean/);
  const noGate = await runAuditFix(tmp(), [], {}, {}, { git: fakeGit(), fileExists: () => true, readFile: () => "", testCmd: null });
  assert.match(noGate.error, /test gate/);
});

test("runAuditFix --dry-run plans without a branch or writer, and honors the fail-closed gate", async () => {
  const git = fakeGit();
  let applied = 0;
  const out = await runAuditFix(
    tmp(),
    [loc({ file: "a.mjs", title: "fix" }), { severity: "P2", scope: "cross-cutting", file: "b.mjs", title: "ssot" }, { severity: "P1", file: "c.mjs", title: "no-scope" }],
    {},
    { dryRun: true },
    baseDeps(git, { applyFix: async () => { applied += 1; } })
  );
  assert.equal(out.dryRun, true);
  assert.equal(out.planned.length, 1, "only the localized+scoped finding is planned");
  assert.equal(out.rejected.length, 2, "cross-cutting AND missing-scope rejected");
  assert.equal(applied, 0);
  assert.equal(git.calls.length, 0);
});

test("runAuditFix caps the number of fixes via --max-fixes", async () => {
  const git = fakeGit();
  const findings = [loc({ file: "a.mjs", title: "1" }), loc({ file: "b.mjs", title: "2" }), loc({ file: "c.mjs", title: "3" })];
  const out = await runAuditFix(tmp(), findings, {}, { maxFixes: 2 }, baseDeps(git, { applyFix: async () => git.setChanged(["dummy"]) }));
  // 2 fixes attempted (each reverts as out-of-scope here), 1 capped away
  assert.equal(out.capped, 1);
});

test("runAuditFix never auto-fixes cross-cutting findings even in a real run", async () => {
  const git = fakeGit();
  const out = await runAuditFix(tmp(), [{ severity: "P0", scope: "cross-cutting", file: "b.mjs", title: "consolidate" }], {}, {}, baseDeps(git, { applyFix: async () => git.setChanged(["b.mjs"]) }));
  assert.equal(out.fixed?.length ?? 0, 0);
  assert.ok(!out.branch);
  assert.ok(out.rejected.some((r) => /cross-cutting/.test(r.reason)));
});
