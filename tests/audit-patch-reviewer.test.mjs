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
  assert.ok(args.includes("--safe-mode"), "safe-mode disables audited-repo CLAUDE.md/hooks/plugins/MCP");
  assert.equal(args[args.indexOf("--model") + 1], "claude-opus-4-8");
  assert.equal(args[args.indexOf("--effort") + 1], "xhigh", "A2: reviewer reasons at xhigh by default");
  assert.equal(buildClaudeReviewArgs({ claudeEffort: "high" })[buildClaudeReviewArgs({ claudeEffort: "high" }).indexOf("--effort") + 1], "high", "explicit effort wins");
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

test("makePatchReviewer: a failed/timed-out Codex/Grok run casts NO vote even if it emitted CONFIRM", async () => {
  const review = makePatchReviewer("/x", {}, {}, {
    runClaude: async () => "VERDICT: CONFIRM\nREASON: ok",
    runCodex: async () => ({ status: 1, stdout: "VERDICT: CONFIRM" }),               // non-zero exit → no vote
    runGrok: async () => ({ status: 124, timedOut: true, stdout: "VERDICT: CONFIRM" }) // timed out → no vote
  });
  const verdicts = await review(patch);
  assert.equal(verdicts.length, 1, "only the cleanly-completed claude run voted");
  assert.equal(evaluatePatchVerdicts(verdicts).approved, false, "a truncated/failed run cannot manufacture unanimity");
});

test("makePatchReviewer: a truncated (partial) Codex/Grok run casts no vote", async () => {
  const review = makePatchReviewer("/x", {}, {}, {
    runClaude: async () => "VERDICT: CONFIRM\nREASON: ok",
    runCodex: async () => ({ status: 0, truncated: true, stdout: "VERDICT: CONFIRM" }),
    runGrok: async () => "VERDICT: CONFIRM\nREASON: ok"
  });
  const verdicts = await review(patch);
  assert.equal(verdicts.length, 2);
  assert.equal(evaluatePatchVerdicts(verdicts).approved, false, "codex truncated → missing → not unanimous");
});

test("makePatchReviewer: three genuine confirms approve the patch", async () => {
  const ok = async () => "VERDICT: CONFIRM\nREASON: correct";
  const review = makePatchReviewer("/x", {}, {}, { runClaude: ok, runCodex: ok, runGrok: ok });
  assert.equal(evaluatePatchVerdicts(await review(patch)).approved, true);
});

test("patchReviewerReady requires all three seats reachable", () => {
  // Reachability comes from the ACTUAL probes, not fallback bin names.
  assert.equal(patchReviewerReady({ claude: { cli: { available: true } }, codex: { companionAvailable: true }, grok: { cli: { available: true } } }).ready, true);
  assert.equal(patchReviewerReady({ claude: { cli: { available: true } }, codex: { companionAvailable: false }, grok: { cli: { available: true } } }).ready, false);
  // a fallback bin name with a FAILED probe is NOT reachable
  assert.equal(patchReviewerReady({ claude: { bin: "claude", cli: { available: false } }, codex: { companionAvailable: true }, grok: { bin: "grok", cli: { available: false } } }).ready, false);
  // codex CLI present but companion ABSENT is NOT ready — the codex seat votes only via the
  // companion, so cli.available alone would print ENABLED yet never confirm.
  assert.equal(patchReviewerReady({ claude: { cli: { available: true } }, codex: { companionAvailable: false, cli: { available: true } }, grok: { cli: { available: true } } }).ready, false);
});
