import test from "node:test";
import assert from "node:assert/strict";

import { collectVerdicts, evaluateApproval, selectActionable } from "../plugins/council/scripts/lib/verdicts.mjs";

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

test("selectActionable: consensus and P0 always in; lone P1 only when someone blocked", () => {
  const merged = {
    all: [
      { severity: "P1", title: "consensus issue", consensus: true, agents: ["codex", "grok"] },
      { severity: "P0", title: "lone p0", consensus: false, agents: ["grok"] },
      { severity: "P1", title: "lone p1", consensus: false, agents: ["grok"] },
      { severity: "P2", title: "policy item", consensus: false, needsConsensus: true, agents: ["grok"] },
      { severity: "P1", title: "conceded", consensus: true, agents: ["codex", "grok"], debate: { stance: "concede" } },
      { severity: "nit", title: "a nit", consensus: false, agents: ["grok"] }
    ]
  };
  const noBlock = selectActionable(merged, { anyBlocker: false }).map((f) => f.title);
  assert.ok(noBlock.includes("consensus issue"));
  assert.ok(noBlock.includes("lone p0"));
  assert.ok(noBlock.includes("policy item"));
  assert.ok(!noBlock.includes("lone p1"), "lone P1 excluded when nobody blocked");
  assert.ok(!noBlock.includes("conceded"));
  assert.ok(!noBlock.includes("a nit"));

  const withBlock = selectActionable(merged, { anyBlocker: true }).map((f) => f.title);
  assert.ok(withBlock.includes("lone p1"), "lone P1 included when an agent blocked");
});

test("selectActionable never returns nits, even consensus nits", () => {
  const merged = {
    all: [
      { severity: "nit", title: "consensus nit", consensus: true, agents: ["codex", "grok"] },
      { severity: "P2", title: "consensus p2", consensus: true, agents: ["codex", "grok"] }
    ]
  };
  const titles = selectActionable(merged, {}).map((f) => f.title);
  assert.ok(!titles.includes("consensus nit"), "consensus nit is not actionable");
  assert.ok(titles.includes("consensus p2"), "consensus P2 is actionable");
});

test("evaluateApproval: incomplete detection is the caller's job; approval math is exact", () => {
  // Only one non-writer voter but needed=2 -> not approved (caller also sets incomplete).
  const r = evaluateApproval([{ agent: "grok", verdict: "approve" }], { writer: "claude", needed: 2 });
  assert.equal(r.voters.length, 1);
  assert.equal(r.approved, false);
});

test("collectVerdicts reads verdict from findings docs and skips absent/skipped", () => {
  const r1 = [
    { agent: "codex", status: 0, findings: { verdict: "approve", parseOk: true } },
    { agent: "grok", verdict: "request_changes" },
    { agent: "claude", skipped: true },
    { agent: "x", status: 0, findings: {} }
  ];
  assert.deepEqual(collectVerdicts(r1), [
    { agent: "codex", verdict: "approve" },
    { agent: "grok", verdict: "request_changes" }
  ]);
});

test("collectVerdicts drops timed-out / parse-failed / non-zero-exit peers (synthetic verdicts)", () => {
  const r1 = [
    { agent: "codex", status: 124, timedOut: true, findings: { verdict: "request_changes", parseOk: false } },
    { agent: "grok", status: 0, findings: { verdict: "approve", parseOk: true } },
    { agent: "other", status: 0, findings: { verdict: "block", parseOk: false } }
  ];
  // Only the genuine grok verdict survives; codex (timeout) and other (parse-fail) drop.
  assert.deepEqual(collectVerdicts(r1), [{ agent: "grok", verdict: "approve" }]);
});
