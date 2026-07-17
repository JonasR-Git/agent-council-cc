import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildFixWriteArgs,
  classifyFixable,
  contentProtectionReason,
  detectOracleCmd,
  enforceTouched,
  ineligibleReason,
  isSensitiveClass,
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

test("ineligibleReason: a reattributed logical finding needs multi-seat consensus before auto-fix", () => {
  // fixLens diverges from lens → surfaced under logical_sense (propose-only coverage lens), routed to
  // correctness. Single-seat → propose-only; multi-seat consensus (or verified-supported) → eligible.
  const base = { severity: "P1", scope: "localized", file: "a.mjs", lens: "logical_sense", fixLens: "correctness" };
  assert.match(ineligibleReason({ ...base, consensus: "single" }), /multi-seat consensus/);
  assert.match(ineligibleReason({ ...base, consensus: "contested" }), /multi-seat consensus/);
  assert.equal(ineligibleReason({ ...base, consensus: "consensus" }), null, "multi-seat consensus is auto-eligible");
  assert.equal(ineligibleReason({ ...base, consensus: "single", verified: { refuted: false } }), null, "adversarial-verified single seat is eligible");
  // A NATIVE correctness finding (fixLens === lens, i.e. no divergence → fixLens absent) is unaffected.
  assert.equal(ineligibleReason({ severity: "P1", scope: "localized", file: "a.mjs", lens: "correctness", consensus: "single" }), null, "a native correctness bug is not consensus-gated here");
});

test("ineligibleReason rejects §6 sensitive classes (auth/crypto/concurrency/data) even when localized", () => {
  assert.match(ineligibleReason({ severity: "P1", scope: "localized", file: "a.mjs", category: "security" }), /sensitive/);
  assert.match(ineligibleReason({ severity: "P0", scope: "localized", file: "a.mjs", category: "concurrency" }), /sensitive/);
  assert.match(ineligibleReason({ severity: "P1", scope: "localized", file: "a.mjs", category: "auth" }), /sensitive/);
  assert.match(ineligibleReason({ severity: "P1", scope: "localized", file: "a.mjs", lens: "data_integrity" }), /sensitive/);
  assert.equal(ineligibleReason({ severity: "P1", scope: "localized", file: "a.mjs", category: "correctness" }), null, "ordinary bugs stay fixable");
});

test("isSensitiveClass: a reattributed finding whose fixLens is sensitive is caught (council P1 — §6 bypass)", () => {
  // Coverage lens stays logical_sense; the native sensitive lens lives in fixLens. Must still be sensitive.
  assert.equal(isSensitiveClass({ category: "secret", lens: "logical_sense", fixLens: "security_secrets" }), true);
  assert.equal(isSensitiveClass({ category: "resource", lens: "logical_sense", fixLens: "concurrency_resources" }), true);
  assert.equal(isSensitiveClass({ category: "data", lens: "logical_sense", fixLens: "data_integrity" }), true);
  // And the gate reflects it: such a finding stays propose-only without sensitiveAutoApply.
  assert.match(ineligibleReason({ severity: "P1", scope: "localized", file: "a.mjs", consensus: "consensus", lens: "logical_sense", fixLens: "security_secrets", category: "secret" }), /sensitive/);
  // A non-sensitive reattributed finding (fixLens correctness) is NOT falsely flagged sensitive.
  assert.equal(isSensitiveClass({ category: "bug", lens: "logical_sense", fixLens: "correctness" }), false);
});

test("isSensitiveClass trims + case-folds BOTH category and lens (kept in sync with structure-gate's twin)", () => {
  // trailing-space category must still classify as sensitive (a normalizer/model slip)
  assert.equal(isSensitiveClass({ category: "security " }), true, "trailing-space category must still be sensitive");
  // mixed-case + surrounding whitespace lens must still classify as sensitive
  assert.equal(isSensitiveClass({ lens: " Security_Secrets " }), true, "case/whitespace lens must still be sensitive");
  assert.equal(isSensitiveClass({ category: "Concurrency" }), true, "case-only category variant stays sensitive");
  assert.equal(isSensitiveClass({ category: "correctness" }), false, "an ordinary category is never sensitive");
  // the ineligibleReason gate must reflect the same hardening end-to-end
  assert.match(
    ineligibleReason({ severity: "P1", scope: "localized", file: "a.mjs", category: "security " }),
    /sensitive/,
    "a trailing-space category must not slip an auth/crypto fix past the §6 gate into ordinary auto-apply"
  );
});

test("ineligibleReason keeps a refuted finding propose-only (annotate-only refuter never auto-fixes disputed)", () => {
  assert.match(ineligibleReason({ severity: "P1", scope: "localized", file: "a.mjs", verified: { refuted: true } }), /refuted/);
  // an un-refuted / verified-but-not-refuted finding stays fixable
  assert.equal(ineligibleReason({ severity: "P1", scope: "localized", file: "a.mjs", verified: { refuted: false } }), null);
});

test("ineligibleReason lets §6 through ONLY under consented sensitiveAutoApply; other gates still hold", () => {
  const race = { severity: "P1", scope: "localized", file: "a.mjs", category: "concurrency" };
  assert.match(ineligibleReason(race), /sensitive/, "default: propose-only");
  assert.equal(ineligibleReason(race, { sensitiveAutoApply: true }), null, "consented: flows to the council gate");
  // consent must NOT relax any other gate
  assert.match(ineligibleReason({ ...race, scope: "cross-cutting" }, { sensitiveAutoApply: true }), /cross-cutting/);
  assert.match(ineligibleReason({ ...race, file: "../x" }, { sensitiveAutoApply: true }), /unsafe file path/);
  assert.match(ineligibleReason({ ...race, severity: "nit" }, { sensitiveAutoApply: true }), /severity gate/);
});

test("PROTECTED_RE blocks secrets/CI/infra AND matches Windows separators", () => {
  for (const file of ["node_modules/x/i.mjs", ".git/config", "dist/b.js", ".env", ".env.production", ".github/workflows/ci.yml", "Dockerfile", "secrets/key.pem", "config/id.key"]) {
    assert.match(ineligibleReason({ severity: "P1", scope: "localized", file }), /protected/, `posix ${file} protected`);
  }
  // Windows-separator variants must ALSO be caught (normalized before matching).
  assert.match(ineligibleReason({ severity: "P1", scope: "localized", file: "node_modules\\pkg\\i.mjs" }), /protected/);
  assert.match(ineligibleReason({ severity: "P1", scope: "localized", file: ".github\\workflows\\ci.yml" }), /protected/);
});

test("contentProtectionReason catches migration/CI/generated/secret shapes, passes normal code", () => {
  assert.equal(contentProtectionReason("export const x = 1;\nfunction f(){ return 2; }\n"), null);
  assert.match(contentProtectionReason("// @generated by tool\nexport const x = 1;\n"), /generated/);
  assert.match(contentProtectionReason("exports.up = async (knex) => knex.schema.createTable('u', () => {});\n"), /migration/);
  assert.match(contentProtectionReason("await db.query('CREATE TABLE users (id int)');\n"), /migration/);
  assert.match(contentProtectionReason("pipeline {\n  stage('build') { sh 'make' }\n}\n"), /CI\/pipeline/);
  assert.match(contentProtectionReason("-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n"), /secret/);
  // a param literally named apiKey in normal code must NOT trip the secret rule
  assert.equal(contentProtectionReason("function auth(apiKey) { return fetch(url, { apiKey }); }\n"), null);
});

test("generated marker protects only a file whose HEADER carries it (not a mid-file mention)", () => {
  assert.match(contentProtectionReason("// @generated by tool\nexport const x = 1;\n"), /generated/, "header marker -> protected");
  const midFile = `${"const x = 1;\n".repeat(120)}// prompt string: Do not edit files.\n`;
  assert.equal(contentProtectionReason(midFile), null, "'Do not edit' deep in a file (a prompt string) does not make it generated");
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
  // bypassPermissions (not acceptEdits): acceptEdits silently no-op'd every Edit in a headless
  // spawn (workflow-review lock), so no autonomous fix ever landed. The sandbox stays intact via
  // --disallowed-tools (Bash below is still deny-only); bypassPermissions only drops the approval gate.
  assert.equal(args[args.indexOf("--permission-mode") + 1], "bypassPermissions");
  assert.equal(args[args.indexOf("--model") + 1], "claude-opus-4-8");
  assert.equal(args[args.indexOf("--effort") + 1], "xhigh", "A2: fixer reasons at xhigh by default");
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
  resolveLedger: () => true,
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

// --- §5 char-test gate: behaviour-preserving refactor guard ------------------

const refactor = (o) => loc({ file: "a.mjs", title: "consolidate SSOT", lens: "architecture_ssot", ...o });

test("runAuditFix §5: a refactor commits only after char-test ACCEPT (pre-apply) + VERIFY (post-fix) both pass", async () => {
  const git = fakeGit();
  const seen = [];
  const charTestGate = {
    eligible: (f) => f.lens === "architecture_ssot",
    accept: async () => { seen.push("accept"); return { accepted: true, code: "TEST", reason: "pinned" }; },
    verify: async () => { seen.push("verify"); return { pass: true, reason: "preserved" }; }
  };
  const out = await runAuditFix(tmp(), [refactor()], {}, {}, baseDeps(git, {
    applyFix: async () => { seen.push("apply"); git.setChanged(["a.mjs"]); },
    charTestGate
  }));
  assert.equal(out.fixed.length, 1, "committed after both phases");
  assert.deepEqual(seen, ["accept", "apply", "verify"], "accept runs on the CLEAN tree before apply; verify after");
});

test("runAuditFix §5: a refactor whose behaviour can't be CHARACTERISED stays propose-only (no apply)", async () => {
  const git = fakeGit();
  let applied = 0;
  const out = await runAuditFix(tmp(), [refactor()], {}, {}, baseDeps(git, {
    applyFix: async () => { applied += 1; git.setChanged(["a.mjs"]); },
    charTestGate: { eligible: () => true, accept: async () => ({ accepted: false, reason: "non-deterministic target" }), verify: async () => ({ pass: true }) }
  }));
  assert.equal(applied, 0, "the fix is never applied when the char-test can't be accepted");
  assert.equal(out.fixed.length, 0);
  assert.ok(out.rejected.some((r) => /char-test/.test(r.reason)), "surfaced as a §5 propose-only");
});

test("runAuditFix §5: a refactor that turns the pinned test RED is reverted to propose-only (behaviour changed)", async () => {
  const git = fakeGit();
  const out = await runAuditFix(tmp(), [refactor()], {}, {}, baseDeps(git, {
    applyFix: async () => git.setChanged(["a.mjs"]),
    charTestGate: { eligible: () => true, accept: async () => ({ accepted: true, code: "T" }), verify: async () => ({ pass: false, reason: "the characterization test went RED after the refactor" }) }
  }));
  assert.equal(out.fixed.length, 0);
  assert.ok(git.calls.some((c) => c[0] === "resetHard"), "the refactor is reverted");
  assert.ok(out.rejected.some((r) => /char-test.*RED|RED.*refactor/.test(r.reason)));
});

test("runAuditFix §5: a NON-refactor finding (correctness) is NOT char-test-gated", async () => {
  const git = fakeGit();
  let accepted = 0;
  const out = await runAuditFix(tmp(), [loc({ file: "a.mjs", title: "fix bug", lens: "correctness" })], {}, {}, baseDeps(git, {
    applyFix: async () => git.setChanged(["a.mjs"]),
    charTestGate: { eligible: (f) => f.lens === "architecture_ssot", accept: async () => { accepted += 1; return { accepted: true }; }, verify: async () => ({ pass: true }) }
  }));
  assert.equal(accepted, 0, "a correctness fix (intends to change behaviour) is not gated by a char-test");
  assert.equal(out.fixed.length, 1);
});

// --- §6 council gate: sensitive-class auto-apply -----------------------------

const sensitiveGit = (o) => Object.assign(fakeGit(o), { diffText: () => "@@ -1 +1 @@\n-old\n+new\n" });
const race = (o) => loc({ file: "a.mjs", title: "fix the race", category: "concurrency", ...o });

test("runAuditFix: a §6 fix commits only after a UNANIMOUS council patch-review", async () => {
  const git = sensitiveGit();
  const seen = [];
  const out = await runAuditFix(tmp(), [race()], {}, { sensitiveAutoApply: true }, baseDeps(git, {
    applyFix: async () => git.setChanged(["a.mjs"]),
    reviewPatch: async ({ diff }) => {
      seen.push(diff);
      return [{ seat: "claude", verdict: "confirm" }, { seat: "codex", verdict: "confirm" }, { seat: "grok", verdict: "confirm" }];
    }
  }));
  assert.equal(out.fixed.length, 1);
  assert.ok(out.fixed[0].council?.approved, "carries the council verdict");
  assert.match(seen[0], /\+new/, "the reviewer received the real unified diff");
  assert.ok(git.calls.some((c) => c[0] === "commitFile"));
});

test("runAuditFix: a §6 fix is reverted + proposed when any seat dissents (fail-closed veto)", async () => {
  const git = sensitiveGit();
  const out = await runAuditFix(tmp(), [race()], {}, { sensitiveAutoApply: true }, baseDeps(git, {
    applyFix: async () => git.setChanged(["a.mjs"]),
    reviewPatch: async () => [{ seat: "claude", verdict: "confirm" }, { seat: "codex", verdict: "confirm" }, { seat: "grok", verdict: "dissent" }]
  }));
  assert.equal(out.fixed.length, 0, "not committed");
  assert.ok(git.calls.some((c) => c[0] === "resetHard"), "reverted");
  assert.ok(out.rejected.some((r) => /council not unanimous/.test(r.reason)));
});

test("runAuditFix: a §6 fix is reverted when the reviewer throws (fail-closed)", async () => {
  const git = sensitiveGit();
  const out = await runAuditFix(tmp(), [race()], {}, { sensitiveAutoApply: true }, baseDeps(git, {
    applyFix: async () => git.setChanged(["a.mjs"]),
    reviewPatch: async () => { throw new Error("codex offline"); }
  }));
  assert.equal(out.fixed.length, 0);
  assert.ok(out.rejected.some((r) => /council review error/.test(r.reason)));
});

test("runAuditFix: §6 stays propose-only when consent is set but NO reviewer is injected", async () => {
  const git = sensitiveGit();
  let applied = 0;
  const out = await runAuditFix(tmp(), [race()], {}, { sensitiveAutoApply: true }, baseDeps(git, {
    applyFix: async () => { applied += 1; git.setChanged(["a.mjs"]); }
    // no reviewPatch injected
  }));
  assert.equal(out.fixed.length, 0);
  assert.equal(applied, 0, "writer never invoked — rejected upfront, no patch leaked");
  assert.ok(out.rejected.some((r) => /sensitive class/.test(r.reason)));
});

test("runAuditFix: §6 stays propose-only when consent is absent (default safety)", async () => {
  const git = sensitiveGit();
  let reviewed = 0;
  const out = await runAuditFix(tmp(), [race()], {}, {}, baseDeps(git, {
    applyFix: async () => git.setChanged(["a.mjs"]),
    reviewPatch: async () => { reviewed += 1; return []; }
  }));
  assert.equal(out.fixed.length, 0);
  assert.equal(reviewed, 0, "reviewer never consulted without consent");
  assert.ok(out.rejected.some((r) => /sensitive class/.test(r.reason)));
});

test("runAuditFix: §6 fails closed when no diff can be produced for review", async () => {
  const git = fakeGit(); // plain fakeGit has NO diffText
  let reviewed = 0;
  const out = await runAuditFix(tmp(), [race()], {}, { sensitiveAutoApply: true }, baseDeps(git, {
    applyFix: async () => git.setChanged(["a.mjs"]),
    reviewPatch: async () => { reviewed += 1; return []; }
  }));
  assert.equal(out.fixed.length, 0);
  assert.equal(reviewed, 0, "reviewer never consulted without a real diff");
  assert.ok(out.rejected.some((r) => /cannot produce a diff/.test(r.reason)));
});

test("runAuditFix ABORTS (ok:false, stranded) when a revert cannot restore the tree", async () => {
  const git = fakeGit();
  git.resetHard = () => { throw new Error("git reset --hard failed: disk full"); };
  const out = await runAuditFix(
    tmp(),
    [loc({ file: "a.mjs", title: "fix" }), loc({ file: "b.mjs", title: "second" })],
    {},
    {},
    baseDeps(git, { applyFix: async () => git.setChanged(["a.mjs", "sneaky.mjs"]) }) // out-of-scope → revert path
  );
  assert.equal(out.ok, false);
  assert.equal(out.stranded, true);
  assert.match(String(out.aborted), /tree not restored/);
  assert.ok(!git.calls.some((c) => c[0] === "commitFile"), "never commits over an unrestored tree");
});

test("runAuditFix resolves each committed fix in the ledger, but not on a red integration run", async () => {
  // happy: fix committed + integration green -> ledger resolved
  const git = fakeGit();
  const resolved = [];
  const out = await runAuditFix(tmp(), [loc({ file: "a.mjs", title: "fix me" })], {}, {}, baseDeps(git, {
    applyFix: async () => git.setChanged(["a.mjs"]),
    resolveLedger: (fp, status) => (resolved.push([fp, status]), true)
  }));
  assert.equal(out.ledgerResolved, 1);
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0][1], "fixed-pending-merge", "provisional until the branch merges");

  // red final integration: commits kept on the branch but NOT marked fixed (may be discarded)
  const git2 = fakeGit();
  let n = 0;
  const resolved2 = [];
  const out2 = await runAuditFix(tmp(), [loc({ file: "a.mjs", title: "fix me" })], {}, {}, baseDeps(git2, {
    applyFix: async () => git2.setChanged(["a.mjs"]),
    runTests: async () => ({ ok: ++n === 1 }), // per-fix green, integration red
    resolveLedger: (fp, status) => (resolved2.push([fp, status]), true)
  }));
  assert.equal(out2.integrationFailed, true);
  assert.equal(out2.ledgerResolved, 0, "nothing resolved when the branch may be discarded");
  assert.equal(resolved2.length, 0);
});

test("runAuditFix does NOT resolve the ledger for unverified (--allow-untested) fixes", async () => {
  const git = fakeGit();
  const resolved = [];
  const out = await runAuditFix(tmp(), [loc({ file: "a.mjs", title: "fix" })], {}, { allowUntested: true }, baseDeps(git, {
    applyFix: async () => git.setChanged(["a.mjs"]),
    resolveLedger: (fp, s) => (resolved.push([fp, s]), true)
  }));
  assert.equal(out.fixed.length, 1);
  assert.equal(out.fixed[0].verified, false);
  assert.equal(out.ledgerResolved, 0, "an unverified fix must not suppress re-detection");
  assert.equal(resolved.length, 0);
});

test("runAuditFix reverts + rejects an out-of-scope edit; never commits", async () => {
  const git = fakeGit();
  const out = await runAuditFix(tmp(), [loc({ file: "a.mjs", title: "fix" })], {}, {}, baseDeps(git, { applyFix: async () => git.setChanged(["a.mjs", "sneaky.mjs"]) }));
  assert.equal(out.fixed.length, 0);
  assert.match(out.rejected[0].reason, /outside target/);
  assert.ok(git.calls.some((c) => c[0] === "resetHard"));
  assert.ok(!git.calls.some((c) => c[0] === "commitFile"));
});

test("runAuditFix skips a content-protected file WITHOUT ever invoking the writer", async () => {
  const git = fakeGit();
  let applied = 0;
  const out = await runAuditFix(tmp(), [loc({ file: "0001_init.mjs", title: "fix migration" })], {}, {}, baseDeps(git, {
    readFile: () => "exports.up = (knex) => knex.schema.createTable('u', () => {});\n",
    applyFix: async () => { applied += 1; git.setChanged(["0001_init.mjs"]); }
  }));
  assert.equal(applied, 0, "protected content must never reach the write runner");
  assert.equal(out.fixed.length, 0);
  assert.ok(out.rejected.some((r) => /protected by content/.test(r.reason)));
});

test("runAuditFix reverts a fix that changes the file's export surface", async () => {
  const git = fakeGit();
  let phase = 0;
  const out = await runAuditFix(tmp(), [loc({ file: "a.mjs", title: "drops an export" })], {}, {}, baseDeps(git, {
    // before: {x,y}; after the edit: {x} — y silently removed, tests would stay green
    readFile: () => (phase++ === 0 ? "export const x=1;\nexport const y=2;\n" : "export const x=1;\n"),
    applyFix: async () => git.setChanged(["a.mjs"])
  }));
  assert.equal(out.fixed.length, 0);
  assert.match(out.rejected[0].reason, /export surface changed.*removed y/);
  assert.ok(git.calls.some((c) => c[0] === "resetHard"), "reverted the surface-changing edit");
});

test("detectOracleCmd prefers typecheck, falls back to lint, else null", () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, "package.json"), JSON.stringify({ scripts: { lint: "eslint .", typecheck: "tsc --noEmit" } }));
  assert.equal(detectOracleCmd(d).name, "typecheck");
  fs.writeFileSync(path.join(d, "package.json"), JSON.stringify({ scripts: { lint: "eslint ." } }));
  assert.equal(detectOracleCmd(d).name, "lint");
  fs.writeFileSync(path.join(d, "package.json"), JSON.stringify({ scripts: { build: "x" } }));
  assert.equal(detectOracleCmd(d), null);
});

test("runAuditFix reverts a fix that regresses the oracle (baseline was green)", async () => {
  const git = fakeGit();
  let oc = 0;
  const out = await runAuditFix(tmp(), [loc({ file: "a.mjs", title: "lint-breaker" })], {}, {}, baseDeps(git, {
    applyFix: async () => git.setChanged(["a.mjs"]),
    runOracle: async () => ({ ok: oc++ === 0 }) // baseline green, post-fix red
  }));
  assert.equal(out.fixed.length, 0);
  assert.match(out.rejected[0].reason, /oracle regression/);
  assert.ok(git.calls.some((c) => c[0] === "resetHard"));
});

test("runAuditFix disables the oracle gate when the baseline is already red", async () => {
  const git = fakeGit();
  let calls = 0;
  const out = await runAuditFix(tmp(), [loc({ file: "a.mjs", title: "fix" })], {}, {}, baseDeps(git, {
    applyFix: async () => git.setChanged(["a.mjs"]),
    runOracle: async () => (calls++, { ok: false }) // always red -> gate must disable, not block every fix
  }));
  assert.equal(out.oracleGated, false, "a red baseline disables the oracle gate");
  assert.equal(out.oracleState, "disabled");
  assert.equal(out.fixed.length, 1, "the fix still commits under the test gate");
  assert.equal(calls, 3, "baseline retried 3x before disabling, then not used per-fix");
});

test("runAuditFix protects test files, refuses to self-edit assertions", async () => {
  const git = fakeGit();
  const out = await runAuditFix(tmp(), [loc({ file: "tests/foo.test.mjs", title: "assertion inverted" })], {}, {}, baseDeps(git, { applyFix: async () => git.setChanged(["tests/foo.test.mjs"]) }));
  assert.equal(out.fixed?.length ?? 0, 0);
  assert.ok((out.rejected ?? []).some((r) => /protected/.test(r.reason)), "a test file is off-limits to the fix writer");
});

test("runAuditFix reverts a fix that INTRODUCES protected content (hardcoded secret)", async () => {
  const git = fakeGit();
  let phase = 0;
  const out = await runAuditFix(tmp(), [loc({ file: "a.mjs", title: "unblock" })], {}, {}, baseDeps(git, {
    readFile: () => (phase++ === 0 ? "export const x = 1;\n" : "export const x = 1;\nconst k = 'sk_live_ABCDEFGHIJKLMNOP';\n"),
    applyFix: async () => git.setChanged(["a.mjs"])
  }));
  assert.equal(out.fixed.length, 0);
  assert.match(out.rejected[0].reason, /introduced protected content/);
  assert.ok(git.calls.some((c) => c[0] === "resetHard"));
});

test("runAuditFix skips a file above the size cap (propose-only)", async () => {
  const git = fakeGit();
  const big = `export const x = 1;\n${"x".repeat(2_000_001)}`;
  let applied = 0;
  const out = await runAuditFix(tmp(), [loc({ file: "a.mjs", title: "huge" })], {}, {}, baseDeps(git, { readFile: () => big, applyFix: async () => { applied += 1; } }));
  assert.equal(applied, 0);
  assert.equal(out.fixed.length, 0);
  assert.ok(out.rejected.some((r) => /too large/.test(r.reason)));
});

test("runAuditFix does not revert on an oracle TIMEOUT (only on a real diagnostic)", async () => {
  const git = fakeGit();
  let oc = 0;
  const out = await runAuditFix(tmp(), [loc({ file: "a.mjs", title: "fix" })], {}, {}, baseDeps(git, {
    applyFix: async () => git.setChanged(["a.mjs"]),
    runOracle: async () => (oc++ === 0 ? { ok: true } : { ok: false, timedOut: true }) // baseline ok, post-fix times out
  }));
  assert.equal(out.fixed.length, 1, "a timeout skips the gate rather than reverting a possibly-correct fix");
});

test("coverage gate: a fix whose changed lines aren't executed is downgraded to propose-only", async () => {
  const git = fakeGit();
  git.diffLines = () => [5]; // the fix changed line 5
  const coverage = new Map([["a.mjs", new Set([1, 2])]]); // line 5 was never executed
  const out = await runAuditFix(tmp(), [loc({ file: "a.mjs", title: "fix" })], {}, { coverage }, baseDeps(git, { applyFix: async () => git.setChanged(["a.mjs"]) }));
  assert.equal(out.fixed.length, 0);
  assert.match(out.rejected.at(-1).reason, /not executed by any test/);
  assert.ok(git.calls.some((c) => c[0] === "resetHard"));
});

test("coverage gate: a fix whose changed lines ARE covered commits normally", async () => {
  const git = fakeGit();
  git.diffLines = () => [1];
  const coverage = new Map([["a.mjs", new Set([1, 2])]]);
  const out = await runAuditFix(tmp(), [loc({ file: "a.mjs", title: "fix" })], {}, { coverage }, baseDeps(git, { applyFix: async () => git.setChanged(["a.mjs"]) }));
  assert.equal(out.fixed.length, 1);
});

test("coverage gate: a pure DELETION (no changed lines) is EXEMPT, not reverted (council audit — sibling-gate parity)", async () => {
  // git --unified=0 emits a 0-new-side hunk for a deletion → diffLines returns []; coverageOfLines([]) is
  // fail-closed allCovered:false, which previously reverted EVERY deletion-only fix with a "(0 uncovered)"
  // reason. A deletion has no new line to execute → the coverage gate must not apply.
  const git = fakeGit();
  git.diffLines = () => []; // pure deletion
  const coverage = new Map([["a.mjs", new Set([1, 2])]]);
  const out = await runAuditFix(tmp(), [loc({ file: "a.mjs", title: "remove dead code", lens: "dead_code" })], {}, { coverage }, baseDeps(git, { applyFix: async () => git.setChanged(["a.mjs"]) }));
  assert.equal(out.fixed.length, 1, "the deletion-only fix commits (coverage gate exempts it)");
  assert.equal(out.rejected.length, 0, "not reverted with a nonsensical (0 uncovered) reason");
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
  let current = null;
  const out = await runAuditFix(
    tmp(),
    [loc({ severity: "P1", file: "a.mjs", title: "first" }), loc({ severity: "P2", file: "a.mjs", title: "second" })],
    {},
    {},
    baseDeps(git, {
      applyFix: async (_prompt, _task, finding) => { git.setChanged(["a.mjs"]); current = finding?.title ?? null; },
      // The second fix is DETERMINISTICALLY red (its uncommitted change stays red across every flake-retry),
      // so it is not a flake and is correctly reverted; the final integration run (change gone) is green.
      runTests: async () => ({ ok: !(git.changedFiles().length > 0 && current === "second") })
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

test("runAuditFix: a flaky test-red that clears on retry KEEPS the fix (no revert of a correct fix)", async () => {
  const git = fakeGit();
  let calls = 0;
  const out = await runAuditFix(
    tmp(),
    [loc({ file: "a.mjs", title: "flaky-suite" })],
    {},
    {},
    baseDeps(git, {
      applyFix: async () => git.setChanged(["a.mjs"]),
      // First run RED (a suite flake), the retry is GREEN → the red was the suite, not this fix.
      runTests: async () => ({ ok: ++calls !== 1 })
    })
  );
  assert.equal(out.fixed.length, 1, "a flake that clears on retry must not revert a correct fix");
  assert.equal(out.failed.length, 0, "no failure recorded for a cleared flake");
  assert.ok(calls >= 2, "the suite was re-run after the flaky red");
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

test("runAuditFix continues an existing branch and can stay on it (fix loop)", async () => {
  const git = fakeGit();
  git.branchExists = (b) => b === "council/reuse"; // pretend the loop's branch already exists
  const out = await runAuditFix(tmp(), [loc({ file: "a.mjs", title: "fix" })], {}, { branch: "council/reuse", stayOnBranch: true }, baseDeps(git, { applyFix: async () => git.setChanged(["a.mjs"]) }));
  assert.equal(out.branch, "council/reuse");
  assert.ok(git.calls.some((c) => c[0] === "checkout" && c[1] === "council/reuse"), "checked out the existing branch");
  assert.ok(!git.calls.some((c) => c[0] === "createAndCheckout"), "did not create a new branch over the existing one");
  assert.equal(out.returnedToBase, false, "stayOnBranch keeps it on the fix branch for the next pass");
  assert.equal(out.spent, 1, "reports a spend proxy (fix attempts)");
  assert.deepEqual(out.changedFiles, ["a.mjs"]);
});

test("runAuditFix never auto-fixes cross-cutting findings even in a real run", async () => {
  const git = fakeGit();
  const out = await runAuditFix(tmp(), [{ severity: "P0", scope: "cross-cutting", file: "b.mjs", title: "consolidate" }], {}, {}, baseDeps(git, { applyFix: async () => git.setChanged(["b.mjs"]) }));
  assert.equal(out.fixed?.length ?? 0, 0);
  assert.ok(!out.branch);
  assert.ok(out.rejected.some((r) => /cross-cutting/.test(r.reason)));
});

// --- M9 structure pass (double-consented, fail-closed) ------------------------

const structural = (o) => ({ severity: "P1", scope: "cross-cutting", lens: "architecture_ssot", file: "a.mjs", title: "dedup the SSOT violation", ...o });

test("M9: a structural finding stays PROPOSE-ONLY without the structureAutoApply consent (no transform runs)", async () => {
  const git = fakeGit();
  let ran = 0;
  const out = await runAuditFix(tmp(), [structural()], {}, {}, baseDeps(git, {
    runStructureTransform: async () => { ran += 1; return { ok: true, commit: "x" }; }
  }));
  assert.equal(ran, 0, "no consent → the transform runner is never even called");
  assert.equal(out.fixed.length, 0);
  assert.ok(out.rejected.some((r) => /propose-only/.test(r.reason)), "it stays a visible proposal");
});

test("M9: a structural finding stays PROPOSE-ONLY when no transform runner is injected (fail-closed)", async () => {
  const git = fakeGit();
  const out = await runAuditFix(tmp(), [structural()], {}, { structureAutoApply: true }, baseDeps(git, {}));
  assert.equal(out.fixed.length, 0, "consent alone does nothing without the machinery");
  assert.ok(out.rejected.some((r) => /propose-only/.test(r.reason)));
});

test("M9: with BOTH the consent and the runner, an approved transform is APPLIED (and leaves the proposal list)", async () => {
  const git = fakeGit();
  const out = await runAuditFix(tmp(), [structural()], {}, { structureAutoApply: true }, baseDeps(git, {
    runStructureTransform: async () => ({ ok: true, commit: "s0m3c0mm1t", gates: { council: { approved: true } } })
  }));
  assert.equal(out.fixed.length, 1, "the structural finding was applied under the full gate ladder");
  assert.equal(out.fixed[0].commit, "s0m3c0mm1t");
  assert.equal(out.rejected.filter((r) => r.finding?.lens === "architecture_ssot").length, 0, "it is no longer a proposal");
});

test("M9: a transform the gate REFUSED keeps the finding proposed, with the reason appended (never silently dropped)", async () => {
  const git = fakeGit();
  const out = await runAuditFix(tmp(), [structural()], {}, { structureAutoApply: true }, baseDeps(git, {
    runStructureTransform: async () => ({ ok: false, reason: "§6 council not unanimous (dissent: grok)" })
  }));
  assert.equal(out.fixed.length, 0);
  const entry = out.rejected.find((r) => r.finding?.lens === "architecture_ssot");
  assert.ok(entry, "still surfaced as a proposal");
  assert.match(entry.reason, /council not unanimous/, "the operator learns WHY it was not applied");
});

test("M9: a transform that cannot restore the tree ABORTS the run as stranded (never continues on a dirty tree)", async () => {
  const git = fakeGit();
  const out = await runAuditFix(tmp(), [structural()], {}, { structureAutoApply: true }, baseDeps(git, {
    runStructureTransform: async () => ({ ok: false, stranded: true, reason: "reset --hard failed" })
  }));
  assert.equal(out.ok, false);
  assert.equal(out.stranded, true, "an unrestorable tree is fatal — a later fix must never stage un-reviewed bytes");
});

// M9 PER-PASS CAP. The transform loop runs over the ACCUMULATED structural backlog (measured on a real
// repo: 1763 findings) and each transform costs a planner + author + a UNANIMOUS section-6 council, i.e.
// MINUTES. Uncapped, ONE pass runs for DAYS and never hands control back — no re-review, no tier advance,
// no quota checkpoint. The gap was dormant while M9 was starved (0 attempts across 17 live passes) and only
// became reachable when that starvation was fixed. These pin the bound and, just as important, that the cap
// DEFERS rather than drops.
test("M9 cap: at most maxStructurePerPass transforms run in one pass; the rest are DEFERRED, not dropped", async () => {
  const git = fakeGit();
  let ran = 0;
  const findings = Array.from({ length: 25 }, (_, i) => structural({ file: `f${i}.mjs`, title: `ssot dup ${i}` }));
  const out = await runAuditFix(
    tmp(),
    findings,
    {},
    { structureAutoApply: true, maxStructurePerPass: 3 },
    baseDeps(git, { runStructureTransform: async () => { ran += 1; return { ok: false, reason: "gate not satisfied" }; } })
  );
  assert.equal(ran, 3, "exactly the cap ran — not all 25");
  // Nothing is lost: every finding is still a visible proposal, capped ones included.
  assert.equal(out.rejected.length, 25, "all 25 remain proposals — the cap defers, it never drops");
});

test("M9 cap: defaults to 10 when unset (an unbounded pass must never be the default)", async () => {
  const git = fakeGit();
  let ran = 0;
  const findings = Array.from({ length: 25 }, (_, i) => structural({ file: `f${i}.mjs`, title: `ssot dup ${i}` }));
  await runAuditFix(
    tmp(),
    findings,
    {},
    { structureAutoApply: true }, // no maxStructurePerPass
    baseDeps(git, { runStructureTransform: async () => { ran += 1; return { ok: false, reason: "gate not satisfied" }; } })
  );
  assert.equal(ran, 10, "the built-in default bounds the pass even when the caller forgets");
});

test("M9 cap: an APPLIED transform still counts against the cap (cost is per attempt, not per success)", async () => {
  const git = fakeGit();
  let ran = 0;
  const findings = Array.from({ length: 8 }, (_, i) => structural({ file: `f${i}.mjs`, title: `ssot dup ${i}` }));
  const out = await runAuditFix(
    tmp(),
    findings,
    {},
    { structureAutoApply: true, maxStructurePerPass: 2 },
    baseDeps(git, { runStructureTransform: async () => { ran += 1; return { ok: true, commit: `c${ran}` }; } })
  );
  assert.equal(ran, 2);
  assert.equal(out.fixed.length, 2, "both applied");
  assert.equal(out.rejected.length, 6, "the other 6 stay proposals for the next pass");
});
