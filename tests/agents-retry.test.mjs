import assert from "node:assert/strict";
import test from "node:test";

import { JSON_ONLY_REMINDER, buildReformatPrompt, runStructuredWithRetry } from "../plugins/council/scripts/lib/agents.mjs";

test("retries once when the first reply is unparseable, then succeeds with a reminder", async () => {
  const prompts = [];
  const outs = [
    { stdout: "sorry, here is prose", status: 0 },
    { stdout: '{"findings":[]}', status: 0 }
  ];
  const runFor = async (p) => {
    prompts.push(p);
    return outs.shift();
  };
  const parse = (s) => ({ parseOk: s.trim().startsWith("{") });
  const r = await runStructuredWithRetry(runFor, "BASE", parse);
  assert.equal(r.retryAttempts, 2);
  assert.equal(r.stdout, '{"findings":[]}');
  assert.equal(prompts.length, 2);
  assert.equal(prompts[1], `BASE${JSON_ONLY_REMINDER}`, "reminder appended on the retry");
});

test("does not retry when the first reply already parses", async () => {
  let calls = 0;
  const runFor = async () => {
    calls += 1;
    return { stdout: "{}", status: 0 };
  };
  const r = await runStructuredWithRetry(runFor, "BASE", () => ({ parseOk: true }));
  assert.equal(calls, 1);
  assert.equal(r.retryAttempts, 1);
});

test("does not retry a dead backend (skipped / nonzero / timed out)", async () => {
  for (const bad of [{ skipped: true }, { status: 1 }, { status: 0, timedOut: true }]) {
    let calls = 0;
    const runFor = async () => {
      calls += 1;
      return { stdout: "garbage", ...bad };
    };
    const r = await runStructuredWithRetry(runFor, "BASE", () => ({ parseOk: false }));
    assert.equal(calls, 1, `a reminder cannot fix ${JSON.stringify(bad)}`);
    assert.equal(r.retryAttempts, 1);
  }
});

test("stops after maxRetries even if still unparseable, returning the last result", async () => {
  let calls = 0;
  const runFor = async () => {
    calls += 1;
    return { stdout: "still garbage", status: 0 };
  };
  const r = await runStructuredWithRetry(runFor, "BASE", () => ({ parseOk: false }), { maxRetries: 1 });
  assert.equal(calls, 2, "one initial call + one retry");
  assert.equal(r.retryAttempts, 2);
  assert.equal(r.stdout, "still garbage");
});

function fakeBudget(remaining) {
  let r = remaining;
  return { canSpend: (n = 1) => r >= n, charge: (n = 1) => { r -= n; }, get remaining() { return r; } };
}

test("charges the budget for a retry and declines when it can't afford one", async () => {
  // affordable: the retry happens and is charged
  const b = fakeBudget(1);
  const outs = [{ stdout: "prose", status: 0 }, { stdout: "{}", status: 0 }];
  const ok = await runStructuredWithRetry(async () => outs.shift(), "BASE", (s) => ({ parseOk: s === "{}" }), { budget: b });
  assert.equal(ok.retryAttempts, 2);
  assert.equal(b.remaining, 0, "the retry charged exactly 1");
  assert.equal(ok.parseMissed, true);

  // exhausted: no retry is dispatched, but the parse miss is still recorded
  const b2 = fakeBudget(0);
  let calls = 0;
  const denied = await runStructuredWithRetry(
    async () => { calls += 1; return { stdout: "prose", status: 0 }; },
    "BASE",
    () => ({ parseOk: false }),
    { budget: b2 }
  );
  assert.equal(calls, 1, "no retry when the budget is exhausted");
  assert.equal(denied.retryAttempts, 1);
  assert.equal(denied.parseMissed, true, "the parse miss is recorded even without a retry");
});

// --- A5: reformat repair + maxRetries>1 ---

test("A5: a reformat repair salvages a parse miss WITHOUT a full re-run", async () => {
  const prompts = [];
  const outs = [
    { stdout: "here are the findings: prose, not json", status: 0 }, // initial: parse miss
    { stdout: '{"findings":[]}', status: 0 }                          // reformat: valid JSON
  ];
  const runFor = async (p) => { prompts.push(p); return outs.shift(); };
  const parse = (s) => ({ parseOk: s.trim().startsWith("{") });
  const r = await runStructuredWithRetry(runFor, "BASE", parse, { reformat: true });
  assert.equal(r.reformatAttempts, 1);
  assert.equal(r.retryAttempts, 1, "the reformat salvaged it — no full reminder retry");
  assert.equal(r.stdout, '{"findings":[]}');
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /BEGIN UNPARSEABLE REPLY/, "the 2nd call is a reformat prompt, not the base task");
  assert.ok(prompts[1].includes("here are the findings"), "the reformat carries the original garbled content");
});

test("A5: a failed reformat falls through to a reminder retry", async () => {
  const prompts = [];
  const outs = [
    { stdout: "prose one", status: 0 },   // initial miss
    { stdout: "still prose", status: 0 }, // reformat also misses
    { stdout: "{}", status: 0 }           // reminder retry: ok
  ];
  const runFor = async (p) => { prompts.push(p); return outs.shift(); };
  const parse = (s) => ({ parseOk: s.trim() === "{}" });
  const r = await runStructuredWithRetry(runFor, "BASE", parse, { reformat: true });
  assert.equal(r.reformatAttempts, 1, "reformat is tried at most once");
  assert.equal(r.retryAttempts, 2, "one reminder retry after the reformat failed");
  assert.equal(r.stdout, "{}");
  assert.match(prompts[1], /UNPARSEABLE REPLY/);
  assert.equal(prompts[2], `BASE${JSON_ONLY_REMINDER}`, "reminder retry uses the full base task");
});

test("A5: reformat is budget-charged and declined when unaffordable", async () => {
  const b = fakeBudget(1);
  const outs = [{ stdout: "prose", status: 0 }, { stdout: "{}", status: 0 }];
  const ok = await runStructuredWithRetry(async () => outs.shift(), "BASE", (s) => ({ parseOk: s === "{}" }), { budget: b, reformat: true });
  assert.equal(ok.reformatAttempts, 1);
  assert.equal(b.remaining, 0, "the reformat charged exactly 1");
  assert.equal(ok.stdout, "{}");

  const b0 = fakeBudget(0);
  let calls = 0;
  const denied = await runStructuredWithRetry(
    async () => { calls += 1; return { stdout: "prose", status: 0 }; },
    "BASE",
    () => ({ parseOk: false }),
    { budget: b0, reformat: true }
  );
  assert.equal(calls, 1, "neither reformat nor retry when the budget is exhausted");
  assert.equal(denied.reformatAttempts, 0);
  assert.equal(denied.parseMissed, true);
});

test("A5: maxRetries defaults to 2 — a persistently garbled backend gets two reminder retries", async () => {
  let calls = 0;
  const r = await runStructuredWithRetry(
    async () => { calls += 1; return { stdout: "garbage", status: 0 }; },
    "BASE",
    () => ({ parseOk: false })
  );
  assert.equal(calls, 3, "1 initial + 2 reminder retries");
  assert.equal(r.retryAttempts, 3);
});

test("A5: buildReformatPrompt frames the garbled reply and forbids inventing content", () => {
  const p = buildReformatPrompt('{"findings":[garbled');
  assert.match(p, /BEGIN UNPARSEABLE REPLY/);
  assert.match(p, /END UNPARSEABLE REPLY/);
  assert.ok(p.includes('{"findings":[garbled'), "carries the original text verbatim");
  assert.match(p, /do not add,\s*drop, or invent/i);
});
