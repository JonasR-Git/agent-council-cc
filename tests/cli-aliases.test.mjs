import test from "node:test";
import assert from "node:assert/strict";

import {
  expandAliases,
  CANONICAL_VERBS,
  HIDDEN_VERBS
} from "../plugins/council/scripts/lib/cli-aliases.mjs";
import { route, resolveDispatch } from "../plugins/council/scripts/lib/cli-dispatch.mjs";
import { VERB_MUTATION, assertCodeWriteAllowed } from "../plugins/council/scripts/lib/cli-mutation.mjs";

// The legacy old-name ALIAS layer has been REMOVED (docs/cli-surface-design.md, Appendix B migration
// complete). This suite pins the new contract: the OLD command NAMES no longer resolve — each is a CLEAN
// unknown-command error — while the 7 canonical verbs + the hidden verbs still route, and expandAliases is
// now a pure NORMALIZER (no mapping) that leaves canonical/hidden verbs unchanged.

// Every OLD command name that USED to alias to a canonical verb. All must now be REJECTED.
const REJECTED_OLD_NAMES = [
  "deliberate",
  "deliberation",
  "adversarial",
  "adversarial-review",
  "audit",
  "endless",
  "watch",
  "wait",
  "result",
  "cancel",
  "doctor",
  "usage",
  "ledger",
  "history",
  "metrics",
  "fixloop-status",
  "overview"
];

test("REJECTED: every old command name resolves to the CLEAN unknown-command error (not a crash, not a write)", () => {
  for (const name of REJECTED_OLD_NAMES) {
    const r = route([name]);
    assert.equal(r.handler, "error", `old name "${name}" must be rejected, not routed`);
    assert.equal(r.mutationClass, null, `a rejected "${name}" carries no mutationClass`);
    assert.match(
      r.error,
      /^unknown command '.+'\. Verbs: review fix plan build solve status setup\. Run --help\.$/,
      `"${name}" must produce the documented unknown-command error`
    );
    assert.ok(r.error.includes(`'${name}'`), `the error names the offending token "${name}"`);
  }
});

test("REJECTED: a representative old invocation WITH flags/subcommands is still rejected (not silently mapped)", () => {
  // `audit fix` used to fold to the WRITE verb — it must now be an unknown command, never a code writer.
  const auditFix = route(["audit", "fix", "--from", "r.json"]);
  assert.equal(auditFix.handler, "error");
  assert.notEqual(auditFix.mutationClass, "working-tree", "a rejected `audit fix` may never carry working-tree");
  // `watch job1 --once` used to fold to `status --watch` — now unknown.
  assert.equal(route(["watch", "job1", "--once"]).handler, "error");
  // `deliberate --mode adversarial` used to fold to `review --mode deliberate` (+ conflict) — now unknown.
  assert.equal(route(["deliberate", "--mode", "adversarial"]).handler, "error");
});

test("CANONICAL: the 7 verbs still route to their existing handlers", () => {
  assert.equal(route(["review"]).handler, "handleReview");
  assert.equal(route(["fix"]).handler, "handleAudit");
  assert.equal(route(["plan"]).handler, "handlePlan");
  assert.equal(route(["build"]).handler, "handleBuild");
  assert.equal(route(["solve"]).handler, "handleReview");
  assert.equal(route(["status"]).handler, "handleStatus");
  assert.equal(route(["setup"]).handler, "handleSetup");
});

test("expandAliases: leaves canonical + hidden verbs UNCHANGED (no mapping any more)", () => {
  for (const verb of CANONICAL_VERBS) assert.deepEqual(expandAliases([verb]), [verb]);
  for (const verb of HIDDEN_VERBS) assert.deepEqual(expandAliases([verb]), [verb]);
  // an OLD name is likewise left UNCHANGED by the normalizer (the dispatch is what rejects it)
  assert.deepEqual(expandAliases(["deliberate"]), ["deliberate"]);
  assert.deepEqual(expandAliases(["audit", "fix"]), ["audit", "fix"]);
  // flags on a canonical verb pass through verbatim
  assert.deepEqual(expandAliases(["review", "--mode", "deep", "--groups", "lens"]), ["review", "--mode", "deep", "--groups", "lens"]);
});

test("expandAliases: hidden verbs pass through COMPLETELY RAW (spawn protocol byte-exact)", () => {
  // a single space-containing token (JSON payload / Windows path) must NOT be split
  const jobPayload = ["worker", '{"job":"C:\\\\Users\\\\Jonas R\\\\job.json","x":1}'];
  assert.deepEqual(expandAliases(jobPayload), jobPayload);
  const winPath = ["worktree", "add", "C:\\Users\\Jonas R\\wt"];
  assert.deepEqual(expandAliases(winPath), winPath);
  // returns a NEW array (purity) even for the raw passthrough
  const input = ["worker", "--job-id", "x"];
  assert.notEqual(expandAliases(input), input);
});

test("expandAliases: the `--` terminator is preserved; nothing after it is rewritten", () => {
  assert.deepEqual(expandAliases(["status", "--", "--cancel", "job1"]), ["status", "--", "--cancel", "job1"]);
  assert.deepEqual(expandAliases(["review", "--", "--mode", "deep"]), ["review", "--", "--mode", "deep"]);
});

test("expandAliases: a single raw-string rest is tokenized like the handlers' normalizeArgv", () => {
  // The slash path may pass "$ARGUMENTS" as one token; the dispatch must still read the flags it needs.
  assert.deepEqual(expandAliases(["status", "--watch job7 --once"]), ["status", "--watch", "job7", "--once"]);
  assert.deepEqual(expandAliases(["review", "--mode deep"]), ["review", "--mode", "deep"]);
});

test("expandAliases: PURE — returns a new array and never mutates its input; empty argv → []", () => {
  const input = ["status", "--watch", "job1", "--interval", "3"];
  const snapshot = input.slice();
  const out = expandAliases(input);
  assert.deepEqual(input, snapshot, "input argv was mutated");
  assert.notEqual(out, input, "must return a NEW array");
  assert.deepEqual(expandAliases([]), []);
});

test("resolveDispatch: an unknown top-level token → the clean error handler (empty argv → help)", () => {
  const r = resolveDispatch(["totally-unknown", "--x"]);
  assert.equal(r.handler, "error");
  assert.match(r.error, /unknown command 'totally-unknown'/);
  assert.deepEqual(resolveDispatch([]), { verb: null, handler: "help", args: [], mutationClass: null });
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
