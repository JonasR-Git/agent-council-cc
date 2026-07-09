import assert from "node:assert/strict";
import test from "node:test";

import {
  applyPeerVotes,
  dedupeAgainst,
  extractJsonObject,
  mergeFindings,
  parseAgentFindings,
  titleSimilarity
} from "../plugins/council/scripts/lib/findings.mjs";

test("extractJsonObject parses pure JSON", () => {
  assert.deepEqual(extractJsonObject('{"findings":[]}'), { findings: [] });
});

test("extractJsonObject parses prose plus fenced JSON", () => {
  const text = 'notes\n```json\n{"agent":"codex","findings":[]}\n```';
  assert.equal(extractJsonObject(text).agent, "codex");
});

test("extractJsonObject skips prose braces and finds later valid object", () => {
  const text = 'ignore this {not json} but keep walking {"agent":"grok","findings":[]}';
  assert.equal(extractJsonObject(text).agent, "grok");
});

test("extractJsonObject tries multiple fenced blocks", () => {
  const text = '```json\n{bad}\n```\n```json\n{"agent":"claude","findings":[]}\n```';
  assert.equal(extractJsonObject(text).agent, "claude");
});

test("parseOk requires findings or votes array", () => {
  const doc = parseAgentFindings('{"agent":"codex","summary":"object but not findings"}', "codex");
  assert.equal(doc.parseOk, false);
});

test("titleSimilarity uses token-set overlap", () => {
  assert.ok(titleSimilarity("Login submit null crash", "Null crash in login submit") >= 0.4);
});

test("mergeFindings performs fuzzy consensus by same file and close lines", () => {
  const docs = [
    {
      agent: "codex",
      findings: [
        {
          id: "codex-1",
          severity: "P1",
          category: "bug",
          title: "Login submit null crash",
          detail: "a",
          file: "src/login.js",
          line: 10,
          confidence: 0.8
        }
      ]
    },
    {
      agent: "grok",
      findings: [
        {
          id: "grok-1",
          severity: "P2",
          category: "bug",
          title: "Submit handler fails on empty login state",
          detail: "b",
          file: "src/login.js",
          line: 18,
          confidence: 0.7
        }
      ]
    }
  ];
  const merged = mergeFindings(docs);
  assert.equal(merged.consensus.length, 1);
  assert.deepEqual(new Set(merged.consensus[0].agents), new Set(["codex", "grok"]));
});

test("applyPeerVotes agree vote promotes unique finding to consensus", () => {
  const merged = mergeFindings([
    {
      agent: "codex",
      findings: [
        {
          id: "codex-1",
          severity: "P1",
          category: "security",
          title: "Token leak",
          detail: "a",
          file: "src/auth.js",
          line: 3,
          confidence: 0.8
        }
      ]
    }
  ]);
  const voted = applyPeerVotes(merged, [
    {
      agent: "grok",
      aboutAgent: "codex",
      stdout: JSON.stringify({ votes: [{ targetId: "codex-1", vote: "agree", note: "confirmed" }] })
    }
  ]);
  assert.equal(voted.consensus.length, 1);
  assert.equal(voted.unique.length, 0);
  assert.deepEqual(voted.consensus[0].voteAgents, ["grok"]);
});

test("dedupeAgainst drops missed findings matching existing fuzzy bucket", () => {
  const merged = mergeFindings([
    {
      agent: "codex",
      findings: [
        {
          id: "codex-1",
          severity: "P1",
          category: "bug",
          title: "Crash when config is missing",
          detail: "a",
          file: "src/config.js",
          line: 20,
          confidence: 0.8
        }
      ]
    }
  ]);
  const missed = dedupeAgainst(merged, [
    {
      agent: "grok",
      parseOk: true,
      findings: [
        {
          id: "grok-miss-1",
          severity: "P1",
          category: "bug",
          title: "Config missing crash",
          detail: "b",
          file: "src/config.js",
          line: 24,
          confidence: 0.7
        }
      ]
    }
  ]);
  assert.deepEqual(missed, []);
});