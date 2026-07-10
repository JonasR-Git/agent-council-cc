import assert from "node:assert/strict";
import test from "node:test";

import { JSON_ONLY_REMINDER, runStructuredWithRetry } from "../plugins/council/scripts/lib/agents.mjs";

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
