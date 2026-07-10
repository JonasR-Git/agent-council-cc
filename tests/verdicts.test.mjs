import test from "node:test";
import assert from "node:assert/strict";

import { collectVerdicts, evaluateApproval } from "../plugins/council/scripts/lib/verdicts.mjs";

test("evaluateApproval counts non-writer approvals against the threshold", () => {
  const verdicts = [
    { agent: "claude", verdict: "approve" },
    { agent: "codex", verdict: "approve_with_nits" },
    { agent: "grok", verdict: "request_changes" }
  ];
  const asClaudeWriter = evaluateApproval(verdicts, { writer: "claude", needed: 2 });
  // Only codex approves among non-writers -> 1 of 2 -> not approved.
  assert.deepEqual(asClaudeWriter.approvals, ["codex"]);
  assert.deepEqual(asClaudeWriter.blockers, ["grok"]);
  assert.equal(asClaudeWriter.approved, false);

  const noWriter = evaluateApproval(verdicts, { needed: 2 });
  // claude + codex approve -> 2 -> approved.
  assert.equal(noWriter.approved, true);
});

test("writer's own approval never counts", () => {
  const verdicts = [
    { agent: "claude", verdict: "approve" },
    { agent: "codex", verdict: "approve" }
  ];
  const r = evaluateApproval(verdicts, { writer: "claude", needed: 2 });
  assert.equal(r.approvals.length, 1);
  assert.equal(r.approved, false);
});

test("block and unknown verdicts are handled", () => {
  const verdicts = [
    { agent: "codex", verdict: "block" },
    { agent: "grok", verdict: "APPROVE" },
    { agent: "claude", verdict: "weird" }
  ];
  const r = evaluateApproval(verdicts, { writer: "claude", needed: 1 });
  assert.deepEqual(r.approvals, ["grok"]);
  assert.deepEqual(r.blockers, ["codex"]);
  assert.equal(r.approved, true);
});

test("collectVerdicts reads verdict from findings docs and skips absent/skipped", () => {
  const r1 = [
    { agent: "codex", findings: { verdict: "approve" } },
    { agent: "grok", verdict: "request_changes" },
    { agent: "claude", skipped: true },
    { agent: "x", findings: {} }
  ];
  assert.deepEqual(collectVerdicts(r1), [
    { agent: "codex", verdict: "approve" },
    { agent: "grok", verdict: "request_changes" }
  ]);
});
