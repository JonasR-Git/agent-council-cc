import test from "node:test";
import assert from "node:assert/strict";

import {
  expandAliases,
  aliasDeprecationNotes,
  emitAliasNotes,
  _resetAliasNotesForTest,
  COMMAND_ALIASES,
  AUDIT_SUBCOMMAND_ALIASES,
  FLAG_ALIASES,
  CANONICAL_VERBS,
  HIDDEN_VERBS
} from "../plugins/council/scripts/lib/cli-aliases.mjs";
import { VERB_MUTATION, assertCodeWriteAllowed } from "../plugins/council/scripts/lib/cli-mutation.mjs";

// Appendix B (docs/cli-surface-design.md): EVERY old→new alias row. Backward-compat is the whole
// contract, so this table is exhaustive — one row per documented alias, plus flag-carrying cases.
const APPENDIX_B = [
  // canonical verbs pass through unchanged
  [["review"], ["review"]],
  [["fix"], ["fix"]],
  [["plan"], ["plan"]],
  [["build"], ["build"]],
  [["solve"], ["solve"]],
  [["status"], ["status"]],
  [["setup"], ["setup"]],
  // review-mode verb aliases
  [["deliberate"], ["review", "--mode", "deliberate"]],
  [["deliberation"], ["review", "--mode", "deliberate"]],
  [["adversarial"], ["review", "--mode", "adversarial"]],
  [["adversarial-review"], ["review", "--mode", "adversarial"]],
  // audit subcommands → review --mode … (DISTINCT engines) / fix
  [["audit", "run"], ["review", "--mode", "run"]],
  [["audit", "review"], ["review", "--mode", "deep"]],
  [["audit", "endless"], ["review", "--mode", "endless"]],
  [["audit", "fix"], ["fix"]],
  [["audit", "fix", "--loop"], ["fix", "--loop"]],
  // status folds
  [["result"], ["status", "--result"]],
  [["watch"], ["status", "--watch"]],
  [["wait"], ["status", "--wait"]],
  [["cancel"], ["status", "--cancel"]],
  [["cancel", "job1"], ["status", "--cancel", "job1"]],
  [["fixloop-status"], ["status", "--fixloop"]],
  [["overview"], ["status", "--overview"]],
  [["history"], ["status", "--history"]],
  [["metrics"], ["status", "--metrics"]],
  [["usage"], ["status", "--usage"]],
  [["ledger"], ["status", "--ledger"]],
  // setup fold
  [["doctor"], ["setup", "--check"]],
  // hidden verbs pass through
  [["benchmark"], ["benchmark"]],
  [["worktree"], ["worktree"]],
  [["worker"], ["worker"]],
  // flag-carrying rows (Stage-3 spec examples)
  [["audit", "fix", "--loop", "--deep"], ["fix", "--loop", "--deep"]],
  [["watch", "job123", "--interval", "3"], ["status", "--watch", "job123", "--interval", "3"]],
  [["audit", "review", "--groups", "lens"], ["review", "--mode", "deep", "--groups", "lens"]],
  [["audit", "run", "--sarif"], ["review", "--mode", "run", "--sarif"]],
  // implemented flag aliases (additive: these bare flags were previously unknown-flag errors)
  [["review", "--adversarial"], ["review", "--mode", "adversarial"]],
  [["review", "--deliberate"], ["review", "--mode", "deliberate"]]
];

test("expandAliases: table-driven over EVERY Appendix-B row (old argv → canonical argv)", () => {
  for (const [oldArgv, expected] of APPENDIX_B) {
    assert.deepEqual(expandAliases(oldArgv), expected, `alias row: ${JSON.stringify(oldArgv)}`);
  }
});

// A (P1): the audit subcommand is the FIRST NON-OPTION token — flag-BEFORE-subcommand must still fold
// to the writing/reading engine (historically parseArgs yields positionals[0]==="fix"/etc.).
const FLAG_FIRST_AUDIT = [
  [["audit", "--json", "fix"], ["fix", "--json"]],
  [["audit", "--from", "r.json", "fix"], ["fix", "--from", "r.json"]],
  [["audit", "--loop", "fix"], ["fix", "--loop"]],
  [["audit", "--json", "review"], ["review", "--mode", "deep", "--json"]],
  [["audit", "--from", "r.json", "run"], ["review", "--mode", "run", "--from", "r.json"]],
  [["audit", "--loop", "endless"], ["review", "--mode", "endless", "--loop"]],
  // a value-option consuming its value is skipped as a PAIR, not mistaken for the subcommand
  [["audit", "--base", "fix", "review"], ["review", "--mode", "deep", "--base", "fix"]]
];

test("expandAliases: A — audit subcommand resolves as first NON-OPTION token (flag-first still folds)", () => {
  for (const [oldArgv, expected] of FLAG_FIRST_AUDIT) {
    assert.deepEqual(expandAliases(oldArgv), expected, `flag-first audit: ${JSON.stringify(oldArgv)}`);
  }
});

test("expandAliases: IDEMPOTENT — an already-canonical argv expands to itself", () => {
  // every canonical target (the RHS of the tables) is a fixed point
  for (const [, canonical] of [...APPENDIX_B, ...FLAG_FIRST_AUDIT]) {
    assert.deepEqual(expandAliases(canonical), canonical, `not idempotent: ${JSON.stringify(canonical)}`);
  }
  // double-expanding an old row equals single-expanding it
  for (const [oldArgv] of [...APPENDIX_B, ...FLAG_FIRST_AUDIT]) {
    const once = expandAliases(oldArgv);
    assert.deepEqual(expandAliases(once), once, `double-expand differs: ${JSON.stringify(oldArgv)}`);
  }
  // the 7 canonical verbs alone are fixed points
  for (const verb of CANONICAL_VERBS) assert.deepEqual(expandAliases([verb]), [verb]);
  for (const verb of HIDDEN_VERBS) assert.deepEqual(expandAliases([verb]), [verb]);
});

test("expandAliases: B — hidden verbs pass through COMPLETELY RAW (spawn protocol byte-exact)", () => {
  // a single space-containing token (JSON payload / Windows path) must NOT be split
  const jobPayload = ["worker", '{"job":"C:\\\\Users\\\\Jonas R\\\\job.json","x":1}'];
  assert.deepEqual(expandAliases(jobPayload), jobPayload);
  const winPath = ["worktree", "add", "C:\\Users\\Jonas R\\wt"];
  assert.deepEqual(expandAliases(winPath), winPath);
  // an exact --adversarial/--deliberate token is NOT rewritten under a hidden verb
  assert.deepEqual(expandAliases(["benchmark", "--adversarial"]), ["benchmark", "--adversarial"]);
  // returns a NEW array (purity) even for the raw passthrough
  const input = ["worker", "--job-id", "x"];
  assert.notEqual(expandAliases(input), input);
});

test("expandAliases: C — the `--` terminator is preserved; nothing after it is rewritten", () => {
  // action/mode/flag tokens after `--` are positional data, kept verbatim
  assert.deepEqual(expandAliases(["status", "--", "--cancel", "job1"]), ["status", "--", "--cancel", "job1"]);
  assert.deepEqual(expandAliases(["review", "--", "--mode", "deep"]), ["review", "--", "--mode", "deep"]);
  assert.deepEqual(expandAliases(["plan", "--", "--adversarial"]), ["plan", "--", "--adversarial"]);
  // an alias BEFORE `--` still folds; the suffix stays verbatim
  assert.deepEqual(expandAliases(["watch", "job1", "--", "--x"]), ["status", "--watch", "job1", "--", "--x"]);
});

test("expandAliases: G — flag aliases apply ONLY to the review verb family", () => {
  assert.deepEqual(expandAliases(["review", "--deliberate"]), ["review", "--mode", "deliberate"]);
  // NOT rewritten on other verbs
  assert.deepEqual(expandAliases(["plan", "--deliberate"]), ["plan", "--deliberate"]);
  assert.deepEqual(expandAliases(["fix", "--adversarial"]), ["fix", "--adversarial"]);
});

test("expandAliases: PURE — returns a new array and never mutates its input", () => {
  const input = ["watch", "job1", "--interval", "3"];
  const snapshot = input.slice();
  const out = expandAliases(input);
  assert.deepEqual(input, snapshot, "input argv was mutated");
  assert.notEqual(out, input, "must return a NEW array");
});

test("expandAliases: unknown `audit <x>` is left for the handler (not mangled)", () => {
  assert.deepEqual(expandAliases(["audit", "bogus", "--json"]), ["audit", "bogus", "--json"]);
  assert.deepEqual(expandAliases(["audit"]), ["audit"]);
});

test("expandAliases: unknown top-level command passes through untouched", () => {
  assert.deepEqual(expandAliases(["totally-unknown", "--x"]), ["totally-unknown", "--x"]);
  assert.deepEqual(expandAliases([]), []);
});

test("expandAliases: a single raw-string rest is tokenized like the handlers' normalizeArgv", () => {
  // The slash path passes "$ARGUMENTS" as one token; a prepended alias flag must not merge into it.
  assert.deepEqual(
    expandAliases(["watch", "job7 --once"]),
    ["status", "--watch", "job7", "--once"]
  );
  assert.deepEqual(
    expandAliases(["audit", "fix --loop --deep"]),
    ["fix", "--loop", "--deep"]
  );
});

test("aliasDeprecationNotes: one note per deprecated spelling; none for canonical argv", () => {
  assert.deepEqual(aliasDeprecationNotes(["watch"]), [
    "note: `watch` is now `status --watch` (old name still works)"
  ]);
  assert.deepEqual(aliasDeprecationNotes(["audit", "fix"]), [
    "note: `audit fix` is now `fix` (old name still works)"
  ]);
  assert.deepEqual(aliasDeprecationNotes(["audit", "review"]), [
    "note: `audit review` is now `review --mode deep` (old name still works)"
  ]);
  assert.deepEqual(aliasDeprecationNotes(["review", "--adversarial"]), [
    "note: `--adversarial` is now `--mode adversarial` (old spelling still works)"
  ]);
  // canonical verbs emit nothing
  assert.deepEqual(aliasDeprecationNotes(["review"]), []);
  assert.deepEqual(aliasDeprecationNotes(["fix", "--loop"]), []);
});

test("emitAliasNotes: writes to the given stream and DEDUPES per process", () => {
  _resetAliasNotesForTest();
  const lines = [];
  const stream = { write: (s) => lines.push(s) };
  emitAliasNotes(["watch"], { stream });
  emitAliasNotes(["watch"], { stream }); // second time: deduped, no output
  assert.deepEqual(lines, ["note: `watch` is now `status --watch` (old name still works)\n"]);
  // a DIFFERENT deprecated spelling still emits once
  emitAliasNotes(["doctor"], { stream });
  assert.equal(lines.length, 2);
  assert.match(lines[1], /`doctor` is now `setup --check`/);
  _resetAliasNotesForTest();
});

test("alias tables are internally consistent (no stray verb targets)", () => {
  const known = new Set([...CANONICAL_VERBS, ...HIDDEN_VERBS, "audit"]);
  for (const [, m] of Object.entries(COMMAND_ALIASES)) assert.ok(known.has(m.verb), `bad target ${m.verb}`);
  for (const [, m] of Object.entries(AUDIT_SUBCOMMAND_ALIASES)) assert.ok(known.has(m.verb), `bad target ${m.verb}`);
  for (const [k, repl] of Object.entries(FLAG_ALIASES)) {
    assert.ok(k.startsWith("--"), `flag alias key must be a flag: ${k}`);
    assert.ok(Array.isArray(repl) && repl.length >= 1);
  }
});

test("mutationClass: read-only verbs are none/state-only; only fix/build are working-tree", () => {
  assert.equal(VERB_MUTATION.review, "none");
  assert.equal(VERB_MUTATION.plan, "none");
  assert.equal(VERB_MUTATION.solve, "none");
  assert.equal(VERB_MUTATION.status, "state-only");
  assert.equal(VERB_MUTATION.setup, "state-only");
  assert.equal(VERB_MUTATION.fix, "working-tree");
  assert.equal(VERB_MUTATION.build, "working-tree");
});

test("assertCodeWriteAllowed: THROWS for review/plan/solve/status/setup; PASSES for fix/build", () => {
  for (const verb of ["review", "plan", "solve", "status", "setup"]) {
    assert.throws(() => assertCodeWriteAllowed(verb), /mutationClass violation/, `${verb} must be blocked`);
  }
  assert.doesNotThrow(() => assertCodeWriteAllowed("fix"));
  assert.doesNotThrow(() => assertCodeWriteAllowed("build"));
  // an unknown/undefined verb is fail-closed (never allowed to write)
  assert.throws(() => assertCodeWriteAllowed("nope"), /mutationClass violation/);
  assert.throws(() => assertCodeWriteAllowed(undefined), /mutationClass violation/);
});
