import test from "node:test";
import assert from "node:assert/strict";

import { parseAgentFindings, parseCritiqueVotes } from "../plugins/council/scripts/lib/findings.mjs";
import { renderSolveDebates } from "../plugins/council/scripts/lib/solve.mjs";

test("one invalid missed[] item must not reject the peer votes (acceptance P1)", () => {
  const doc = parseCritiqueVotes(
    JSON.stringify({
      agent: "grok",
      about: "codex",
      votes: [{ targetId: "codex-1", vote: "agree", note: "checked" }],
      missed: [{ severity: "P1", line: "not-a-number" }]
    }),
    "grok",
    "codex"
  );
  assert.equal(doc.parseOk, true);
  assert.equal(doc.votes.length, 1);
  assert.equal(doc.votes[0].vote, "agree");
});

test("value sloppiness does not reject a findings doc (acceptance P1)", () => {
  const doc = parseAgentFindings(
    JSON.stringify({
      agent: "codex",
      summary: "s",
      verdict: "LGTM!",
      findings: [
        { title: "Something real", category: "Bug", line: "42", confidence: "0.8" }
      ]
    }),
    "codex"
  );
  assert.equal(doc.parseOk, true);
  assert.equal(doc.verdict, "request_changes");
  assert.equal(doc.findings[0].line, 42);
  assert.equal(doc.findings[0].confidence, 0.8);
  assert.equal(doc.findings[0].severity, "P2");
});

test("known verdicts survive normalization case-insensitively", () => {
  const doc = parseAgentFindings(
    JSON.stringify({ verdict: "Approve_With_Nits", findings: [] }),
    "grok"
  );
  assert.equal(doc.verdict, "approve_with_nits");
});

test("solve debate section renders rebuttals, counters, and resume markers", () => {
  const section = renderSolveDebates([
    { round: 1, id: "plan-grok", agent: "grok", stance: "defend", note: "holds", resumedSession: true },
    { round: 2, id: "plan-grok", agent: "codex", upheld: false, note: "convinced" }
  ]);
  assert.match(section, /## Debate/);
  assert.match(section, /resumed own R1 session/);
  assert.match(section, /withdraws blocker/);
});
