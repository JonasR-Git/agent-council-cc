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

test("parsed doc trusts the RUNNER identity, not model-provided agent (anti-spoof)", () => {
  // A prompt-injected spawn could emit {"agent":"codex"} to impersonate a peer,
  // or a stray "Claude"/"claude-opus" would drop it from agent==='claude' lookups.
  const spoof = parseAgentFindings('{"agent":"codex","verdict":"approve","findings":[]}', "claude");
  assert.equal(spoof.agent, "claude", "runner identity must win over model output");

  const cased = parseAgentFindings('{"agent":"Claude-Opus","verdict":"approve","findings":[{"title":"x"}]}', "claude");
  assert.equal(cased.agent, "claude");
  assert.equal(cased.findings[0].agent, "claude", "per-finding agent is also the runner's");
});

test("unknown runner still honors model-provided agent (no fallback identity to force)", () => {
  const doc = parseAgentFindings('{"agent":"grok","verdict":"approve","findings":[]}', "unknown");
  assert.equal(doc.agent, "grok");
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

test("applyPeerVotes: a targetId vote does NOT fabricate consensus on a same-title finding with a different id", () => {
  // Two DISTINCT findings that share a normalized title but live in different files (so they never
  // merge) and carry different ids. A vote naming ONLY the first must not bleed onto the second via
  // the title fallback.
  const merged = mergeFindings([
    { agent: "codex", findings: [{ id: "codex-1", severity: "P2", category: "correctness", title: "Null deref", detail: "a", file: "src/a.js", line: 3, confidence: 0.8 }] },
    { agent: "grok", findings: [{ id: "grok-9", severity: "P2", category: "correctness", title: "Null deref", detail: "b", file: "src/b.js", line: 3, confidence: 0.8 }] }
  ]);
  const voted = applyPeerVotes(merged, [
    // The vote carries BOTH the precise targetId AND a title (as a real critique does). Only codex-1 is meant.
    { agent: "claude", aboutAgent: "codex", stdout: JSON.stringify({ votes: [{ targetId: "codex-1", title: "Null deref", vote: "agree" }] }) }
  ]);
  const targeted = voted.all.find((i) => i.ids.includes("codex-1"));
  const other = voted.all.find((i) => i.ids.includes("grok-9"));
  assert.equal(targeted.consensus, true, "the finding the vote actually names gains consensus");
  assert.deepEqual(targeted.voteAgents, ["claude"]);
  assert.equal(other.consensus, false, "the same-title but differently-identified finding must stay unique");
  assert.deepEqual(other.voteAgents, [], "no vote leaks onto the untargeted finding");
});

test("applyPeerVotes: a title-only vote (no targetId) still matches by title", () => {
  const merged = mergeFindings([
    { agent: "codex", findings: [{ id: "codex-1", severity: "P2", category: "correctness", title: "Race condition", detail: "a", file: "src/a.js", line: 3, confidence: 0.8 }] }
  ]);
  const voted = applyPeerVotes(merged, [
    { agent: "grok", aboutAgent: "codex", stdout: JSON.stringify({ votes: [{ title: "Race condition", vote: "agree" }] }) }
  ]);
  assert.equal(voted.consensus.length, 1, "a vote with no targetId still falls back to the title match");
  assert.deepEqual(voted.consensus[0].voteAgents, ["grok"]);
});

// --- A6 #1: a null/unknown line must stay NULL (never line 0) ----------------

test("a whole-file finding keeps line null - Number(null)===0 must not invent line 0", () => {
  const doc = parseAgentFindings(
    JSON.stringify({
      agent: "codex",
      findings: [
        { id: "c-1", title: "whole file", file: "a.mjs", line: null },
        { id: "c-2", title: "no line key", file: "a.mjs" },
        { id: "c-3", title: "zero is not a line", file: "a.mjs", line: 0 },
        { id: "c-4", title: "garbage", file: "a.mjs", line: "n/a" },
        { id: "c-5", title: "numeric string still coerces", file: "a.mjs", line: "42" }
      ]
    }),
    "codex"
  );
  assert.equal(doc.findings[0].line, null, '"line": null must stay null, not 0');
  assert.equal(doc.findings[1].line, null);
  assert.equal(doc.findings[2].line, null, "line 0 is not a 1-based location");
  assert.equal(doc.findings[3].line, null);
  assert.equal(doc.findings[4].line, 42, "numeric strings still coerce (schema contract)");
});

test('"confidence": null means unstated (default), never zero confidence', () => {
  const doc = parseAgentFindings(
    JSON.stringify({
      agent: "grok",
      findings: [
        { id: "g-1", title: "null conf", file: "a.mjs", confidence: null },
        { id: "g-2", title: "absent conf", file: "a.mjs" },
        { id: "g-3", title: "explicit zero", file: "a.mjs", confidence: 0 },
        { id: "g-4", title: "string conf", file: "a.mjs", confidence: "0.8" }
      ]
    }),
    "grok"
  );
  assert.equal(doc.findings[0].confidence, 0.6, "null confidence falls back to the default, not 0");
  assert.equal(doc.findings[1].confidence, 0.6);
  assert.equal(doc.findings[2].confidence, 0, "an explicit 0 the model really wrote survives");
  assert.equal(doc.findings[3].confidence, 0.8);
});

test("two unknown-line findings from different seats do NOT fuzzy-merge into fake consensus", () => {
  // Both seats emit "line": null (what every prompt template asks for on a whole-file
  // finding). The old Number(null)->0 coercion made them |0-0| <= 10 "co-located", so a
  // single shared 3-char token ("cache") fused them: one title/detail was DISCARDED and
  // the survivor was exempted from refutation as a "consensus" finding.
  const claude = parseAgentFindings(
    JSON.stringify({
      agent: "claude",
      findings: [{ id: "cl-1", severity: "P2", title: "Unbounded cache growth in the request path", detail: "d1", file: "src/app.mjs", line: null }]
    }),
    "claude"
  );
  const orSeat = parseAgentFindings(
    JSON.stringify({
      agent: "or-mistral",
      findings: [{ id: "or-1", severity: "P1", title: "Cache key collision across tenants", detail: "d2", file: "src/app.mjs", line: null }]
    }),
    "or-mistral"
  );
  assert.ok(titleSimilarity(claude.findings[0].title, orSeat.findings[0].title) < 0.4, "titles are only weakly related");

  const merged = mergeFindings([claude, orSeat]);
  assert.equal(merged.consensus.length, 0, "unlocated findings must not fabricate consensus");
  assert.equal(merged.all.length, 2, "both findings survive as unique");
  const titles = merged.all.map((m) => m.title).sort();
  assert.deepEqual(titles, ["Cache key collision across tenants", "Unbounded cache growth in the request path"]);
});

test("unknown-line findings still merge on a strictly stronger signal (same file + strong title)", () => {
  const merged = mergeFindings([
    {
      agent: "codex",
      findings: [{ id: "c-1", severity: "P1", category: "bug", title: "Missing null check in login submit", detail: "a", file: "src/login.js", line: null, confidence: 0.8 }]
    },
    {
      agent: "claude",
      findings: [{ id: "cl-1", severity: "P2", category: "bug", title: "Login submit missing null check", detail: "b", file: "src/login.js", line: null, confidence: 0.7 }]
    }
  ]);
  assert.equal(merged.consensus.length, 1, "strong title similarity is still a real agreement signal");
  assert.equal(merged.consensus[0].line, null, "...and the bucket stays unlocated");
});

// --- A6 #2: severity synonyms must not silently demote a seat's P0 -----------

test("severity synonyms map onto the P-scale (a configured seat's P0 is not demoted to P2)", () => {
  const cases = [
    ["critical", "P0"], ["Blocker", "P0"], ["SEV-0", "P0"], ["fatal", "P0"],
    ["high", "P1"], ["Major", "P1"], ["sev1", "P1"],
    ["medium", "P2"], ["moderate", "P2"], ["sev 2", "P2"],
    ["low", "nit"], ["minor", "nit"], ["info", "nit"], ["trivial", "nit"], ["style", "nit"],
    ["p0", "P0"], ["P1", "P1"], ["NIT", "nit"]
  ];
  const doc = parseAgentFindings(
    JSON.stringify({
      agent: "or-mistral",
      findings: cases.map(([severity], i) => ({ id: `or-${i}`, severity, title: `t${i}`, file: "a.mjs" }))
    }),
    "or-mistral"
  );
  for (const [i, [raw, expected]] of cases.entries()) {
    assert.equal(doc.findings[i].severity, expected, `${raw} -> ${expected}`);
    assert.equal(doc.findings[i].severityUnrecognized, undefined, `${raw} is a known token`);
  }
  assert.equal(doc.unrecognizedSeverities, undefined, "nothing unrecognised here");
});

test("a genuinely unknown severity token still falls back to P2 - but is SURFACED, not silent", () => {
  const doc = parseAgentFindings(
    JSON.stringify({ agent: "or-x", findings: [{ id: "or-1", severity: "spicy", title: "t", file: "a.mjs" }] }),
    "or-x"
  );
  assert.equal(doc.findings[0].severity, "P2", "fallback stays P2");
  assert.equal(doc.findings[0].severityUnrecognized, true);
  assert.equal(doc.findings[0].severityRaw, "spicy");
  assert.deepEqual(doc.unrecognizedSeverities, [{ id: "or-1", severity: "spicy" }]);
});

test("a canonical severity doc gains no extra fields (back-compat)", () => {
  const doc = parseAgentFindings(
    JSON.stringify({ agent: "codex", findings: [{ id: "c-1", severity: "P0", title: "t", file: "a.mjs" }] }),
    "codex"
  );
  assert.equal(doc.findings[0].severity, "P0");
  assert.ok(!("severityRaw" in doc.findings[0]), "canonical token adds no severityRaw");
  assert.ok(!("severityUnrecognized" in doc.findings[0]));
  assert.ok(!("unrecognizedSeverities" in doc), "canonical doc is unchanged");
});

// --- A6 #3: the first VALID findings doc wins, not the first parseable JSON --

test("a preamble object must not shadow the real findings doc", () => {
  const stdout = '{"status":"analyzing"}\n{"agent":"or-x","verdict":"block","findings":[{"id":"or-1","severity":"P0","title":"Real finding","file":"a.mjs"}]}';
  const doc = parseAgentFindings(stdout, "or-x");
  assert.equal(doc.parseOk, true, "the real doc must win over the preamble");
  assert.equal(doc.findings.length, 1);
  assert.equal(doc.findings[0].title, "Real finding");
  assert.equal(doc.verdict, "block");
});

test("an earlier fenced non-findings block must not shadow a later fenced findings doc", () => {
  const stdout = '```json\n{"note":"thinking out loud"}\n```\nthen:\n```json\n{"findings":[{"id":"x","severity":"P1","title":"Later doc"}]}\n```';
  const doc = parseAgentFindings(stdout, "grok");
  assert.equal(doc.parseOk, true);
  assert.equal(doc.findings[0].title, "Later doc");
});

test("a top-level ARRAY of findings is a valid findings doc", () => {
  const doc = parseAgentFindings('[{"id":"a-1","severity":"critical","title":"Bare list reply","file":"a.mjs","line":null}]', "claude");
  assert.equal(doc.parseOk, true, "a bare findings list must not be discarded");
  assert.equal(doc.agent, "claude");
  assert.equal(doc.findings.length, 1);
  assert.equal(doc.findings[0].title, "Bare list reply");
  assert.equal(doc.findings[0].severity, "P0");
  assert.equal(doc.findings[0].line, null);
  assert.equal(doc.verdict, "request_changes", "a bare list carries no verdict -> fail closed");
});

test("an unrelated leading array must not shadow the real findings doc", () => {
  const doc = parseAgentFindings('["scratch","notes"]\n{"findings":[{"id":"x","severity":"P1","title":"Real doc"}]}', "codex");
  assert.equal(doc.parseOk, true);
  assert.equal(doc.findings[0].title, "Real doc");
});

test("no JSON at all still fails closed with a parse error", () => {
  const doc = parseAgentFindings("I could not review this.", "codex");
  assert.equal(doc.parseOk, false);
  assert.equal(doc.verdict, "request_changes");
  assert.deepEqual(doc.findings, []);
  assert.deepEqual(doc.validationErrors, ["$: no JSON object found"]);
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