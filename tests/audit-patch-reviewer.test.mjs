import assert from "node:assert/strict";
import test from "node:test";

import { buildClaudeReviewArgs, makePatchReviewer, patchReviewerReady } from "../plugins/council/scripts/lib/audit-patch-reviewer.mjs";
import { evaluatePatchVerdicts } from "../plugins/council/scripts/lib/audit-council-gate.mjs";

const patch = { file: "a.mjs", finding: { severity: "P1", category: "concurrency", title: "race", detail: "d" }, diff: "@@ -1 +1 @@\n-x\n+y" };

test("buildClaudeReviewArgs is read-only: inspect tools allowed, edit/exec/network denied", () => {
  const args = buildClaudeReviewArgs({ claudeModel: "claude-opus-4-8" });
  assert.ok(args.includes("Read") && args.includes("Grep") && args.includes("Glob"));
  assert.ok(args.indexOf("Edit") > args.indexOf("--disallowed-tools"), "Edit only in the deny list");
  assert.ok(args.indexOf("Bash") > args.indexOf("--disallowed-tools"), "Bash only in the deny list");
  assert.ok(args.includes("--strict-mcp-config"));
  assert.equal(args[args.indexOf("--model") + 1], "claude-opus-4-8");
});

test("makePatchReviewer runs all three seats on the same patch and returns parsed verdicts", async () => {
  const seen = {};
  const review = makePatchReviewer("/x", {}, {}, {
    runClaude: async (p) => { seen.claude = p; return "VERDICT: CONFIRM\nREASON: ok"; },
    runCodex: async (p) => { seen.codex = p; return { stdout: "VERDICT: CONFIRM\nREASON: ok" }; },
    runGrok: async (p) => { seen.grok = p; return { stdout: "VERDICT: DISSENT\nREASON: risky" }; }
  });
  const verdicts = await review(patch);
  assert.equal(verdicts.length, 3);
  assert.equal(evaluatePatchVerdicts(verdicts).approved, false, "one dissent vetoes");
  // each seat received a prompt naming itself (independent judgement of the SAME patch)
  assert.match(seen.claude, /claude seat/);
  assert.match(seen.codex, /codex seat/);
  assert.match(seen.grok, /grok seat/);
});

test("makePatchReviewer is fail-closed: an erroring or skipped seat casts NO vote", async () => {
  const review = makePatchReviewer("/x", {}, {}, {
    runClaude: async () => "VERDICT: CONFIRM\nREASON: ok",
    runCodex: async () => { throw new Error("codex offline"); },       // error → no vote
    runGrok: async () => ({ skipped: true, reason: "grok not found" }) // skipped → no vote
  });
  const verdicts = await review(patch);
  assert.equal(verdicts.length, 1, "only the reachable seat voted");
  // the gate needs all three: two missing → never approves
  assert.equal(evaluatePatchVerdicts(verdicts).approved, false);
});

test("makePatchReviewer: three genuine confirms approve the patch", async () => {
  const ok = async () => "VERDICT: CONFIRM\nREASON: correct";
  const review = makePatchReviewer("/x", {}, {}, { runClaude: ok, runCodex: ok, runGrok: ok });
  assert.equal(evaluatePatchVerdicts(await review(patch)).approved, true);
});

test("patchReviewerReady requires all three seats reachable", () => {
  assert.equal(patchReviewerReady({ claude: { bin: "/c" }, codex: { companionAvailable: true }, grok: { bin: "/g" } }).ready, true);
  assert.equal(patchReviewerReady({ claude: { bin: "/c" }, codex: { companionAvailable: false }, grok: { bin: "/g" } }).ready, false);
});
