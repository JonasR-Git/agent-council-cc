import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";

import { normalizeOpenRouterModels, openRouterBackend, registerOpenRouterKey, runOpenRouterStructured, OPENROUTER_MAX_SEATS } from "../plugins/council/scripts/lib/openrouter-agent.mjs";
import { isRateLimitError } from "../plugins/council/scripts/lib/audit-retry.mjs";

test("normalizeOpenRouterModels parses the 3 string forms + object form, sanitizes ids", () => {
  const { seats } = normalizeOpenRouterModels(["anthropic/claude-3.5", "gpt=openai/gpt-4o", "r1=deepseek/r1@high", { id: "llama", model: "meta/llama-3.1", effort: "low" }]);
  assert.equal(seats.length, 4);
  assert.equal(seats[0].id, "or-anthropic-claude-3-5");
  assert.equal(seats[1].id, "or-gpt");
  assert.equal(seats[1].model, "openai/gpt-4o");
  assert.equal(seats[2].effort, "high");
  assert.equal(seats[3].id, "or-llama");
  for (const s of seats) assert.match(s.id, /^or-[a-z0-9-]+$/, "ids are sanitized");
});

test("normalizeOpenRouterModels rejects built-in collisions, dedupes, and HARD-CAPS at 5", () => {
  const collide = normalizeOpenRouterModels(["codex=some/model", "grok=x/y"]);
  assert.equal(collide.seats.length, 0, "or-codex / or-grok collide with built-ins → dropped");
  assert.ok(collide.warnings.some((w) => /collides/.test(w)));
  const dup = normalizeOpenRouterModels(["a=x/y", "a=x/z"]);
  assert.equal(dup.seats.length, 1, "duplicate id dropped");
  const dupModel = normalizeOpenRouterModels(["a=vendor/model", "b=vendor/model"]);
  assert.equal(dupModel.seats.length, 1, "duplicate MODEL slug dropped even under distinct ids (no false consensus)");
  assert.ok(dupModel.warnings.some((w) => /model slug/.test(w)));
  const many = normalizeOpenRouterModels(Array.from({ length: 8 }, (_, i) => `m${i}=vendor/model-${i}`));
  assert.equal(many.seats.length, OPENROUTER_MAX_SEATS, "capped at 5");
  assert.ok(many.warnings.some((w) => /capped/.test(w)));
});

test("openRouterBackend: available iff a KEY (env/user) AND ≥1 model; key never in the descriptor", () => {
  const off = openRouterBackend({ openrouterModels: ["a=x/y"] }, {});
  assert.equal(off.available, false, "no key → not available (a repo model list alone can't activate egress)");
  const userKey = openRouterBackend({ openrouterModels: ["a=x/y"] }, {}, "sk-user");
  assert.equal(userKey.available, true, "a user/CLI key (3rd arg) activates");
  assert.equal(JSON.stringify(userKey).includes("sk-user"), false, "the key is NEVER in the returned descriptor");
  const envOnly = openRouterBackend({ openrouterModels: ["a=x/y"] }, { OPENROUTER_API_KEY: "sk-env" });
  assert.equal(envOnly.available, true, "env key works");
  assert.equal(envOnly.keySource, "env");
  assert.equal(JSON.stringify(envOnly).includes("sk-env"), false);
});

test("openRouterBackend footgun closed: options.openrouterApiKey is NOT read (a spread-in repo key can't activate; council Grok P2)", () => {
  // a future caller that spreads repo-parsed policy into options must NOT re-open egress — only the
  // userKeyArg (CLI) or the ENV var can activate. options carrying a key is inert.
  const r = openRouterBackend({ openrouterModels: ["a=x/y"], openrouterApiKey: "sk-repo-leaked" }, {} /* no env */, null /* no user key */);
  assert.equal(r.available, false, "a key on options is ignored → no activation, no egress");
});

test("openRouterBackend P1 exfil: a repo model list + remote base but NO user/env key does NOT activate", () => {
  // simulates a hostile .council.yml: models + base_url but the key path is closed (council passes null
  // as the user key and there is no env key) → nothing egresses.
  const hostile = openRouterBackend({ openrouterModels: ["x=vendor/model"], openrouterBaseUrl: "https://evil.example/v1" }, {} /* no env key */, null /* no user key */);
  assert.equal(hostile.available, false, "no key → not available → no egress from a repo config alone");
  assert.match(hostile.baseURL, /openrouter\.ai/, "the remote base is ignored regardless");
});

test("openRouterBackend EXFIL GUARD: ONLY loopback base_url is honored; remote is always ignored (incl. bypass tricks)", () => {
  const remote = openRouterBackend({ openrouterModels: ["a=x/y"], openrouterBaseUrl: "https://evil.example/v1" }, {}, "sk-user");
  assert.match(remote.baseURL, /openrouter\.ai/, "a remote base is ignored even with a user key");
  assert.equal(remote.available, false, "a refused remote base disables the backend — never egress to the default host with the user key (council Grok P2)");
  assert.ok(remote.warnings.some((w) => /loopback|exfil|DISABLED/i.test(w)));
  const loopback = openRouterBackend({ openrouterModels: ["a=x/y"], openrouterBaseUrl: "http://localhost:11434/v1" }, { OPENROUTER_API_KEY: "sk-env" });
  assert.equal(loopback.baseURL, "http://localhost:11434/v1", "a local proxy is allowed");
  const httpsLoop = openRouterBackend({ openrouterModels: ["a=x/y"], openrouterBaseUrl: "https://127.0.0.1:8443/v1" }, { OPENROUTER_API_KEY: "sk-env" });
  assert.equal(httpsLoop.baseURL, "https://127.0.0.1:8443/v1", "https loopback allowed too");
  for (const trick of ["http://127.0.0.1@evil.com/v1", "https://localhost.evil.com/v1", "http://127.0.0.1.evil.com/v1", "http://LOCALHOST@evil/v1"]) {
    const r = openRouterBackend({ openrouterModels: ["a=x/y"], openrouterBaseUrl: trick }, {}, "sk-user");
    assert.match(r.baseURL, /openrouter\.ai/, `loopback-bypass trick rejected: ${trick}`);
  }
});

test("openRouterBackend: a REJECTED remote base disables the backend fail-closed (no silent retarget to default)", () => {
  // council Codex P1: with a user key AND a remote base, we must NOT silently fall back to openrouter.ai
  // (which would send the source + the proxy token to OpenRouter). The whole backend goes OFF instead.
  const r = openRouterBackend({ openrouterModels: ["a=x/y"], openrouterBaseUrl: "https://corp-proxy.internal/v1" }, {}, "sk-user");
  assert.equal(r.available, false, "a rejected remote base → backend disabled (fail-closed), not retargeted");
  assert.ok(r.warnings.some((w) => /DISABLED/.test(w)));
  // sanity: loopback stays available
  const ok = openRouterBackend({ openrouterModels: ["a=x/y"], openrouterBaseUrl: "http://localhost:8080/v1" }, {}, "sk-user");
  assert.equal(ok.available, true);
});

const seatBackends = () => ({ openrouter: { available: true, baseURL: "https://openrouter.ai/api/v1", seats: [{ id: "or-x", model: "vendor/model" }] } });

test("runOpenRouterStructured: a 2xx content reply → status 0, stdout = content (injected transport, no network)", async () => {
  registerOpenRouterKey("sk-secret");
  const transport = async () => ({ status: 200, body: JSON.stringify({ choices: [{ message: { content: '{"agent":"or-x","findings":[]}' } }] }) });
  const r = await runOpenRouterStructured("/x", seatBackends(), {}, "review this", "or-x", { transport });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /findings/);
  assert.equal(r.agent, "or-x");
});

test("runOpenRouterStructured: a 429 → rate-limit signal; a 401 → permanent; the key is SCRUBBED from stderr", async () => {
  registerOpenRouterKey("sk-secret");
  const b = seatBackends();
  const r429 = await runOpenRouterStructured("/x", b, {}, "p", "or-x", { transport: async () => ({ status: 429, body: "rate limited, key sk-secret leaked" }) });
  assert.equal(r429.status, 429);
  assert.equal(isRateLimitError(`${r429.stderr}`), true, "429 is a transient rate-limit (cell scheduler will back off)");
  assert.equal(r429.stderr.includes("sk-secret"), false, "the API key is scrubbed from surfaced error text");
  assert.match(r429.stderr, /\[redacted\]/);
  const r401 = await runOpenRouterStructured("/x", b, {}, "p", "or-x", { transport: async () => ({ status: 401, body: "invalid api key" }) });
  assert.equal(isRateLimitError(`${r401.stderr}`), false, "401/invalid-key is PERMANENT — never retried");
});

test("runOpenRouterStructured: the REAL postJson honors an absolute wall-clock deadline (a hung endpoint → 124, no infinite hang)", async () => {
  // council Grok P2 (#4): node's socket `timeout` is inactivity-only — a server that accepts the
  // connection but never responds must still settle via the absolute deadline. Exercise the real
  // postJson (no injected transport) against a loopback server that hangs forever.
  const server = http.createServer(() => { /* accept, never respond */ });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    registerOpenRouterKey("sk-secret");
    const backends = { openrouter: { available: true, baseURL: `http://127.0.0.1:${port}`, seats: [{ id: "or-x", model: "vendor/model" }] } };
    const started = Date.now();
    const r = await runOpenRouterStructured("/x", backends, { agentTimeoutMs: 300 }, "p", "or-x", { now: () => Date.now() });
    assert.equal(r.status, 124, "the wall-clock deadline fires → timedOut status");
    assert.equal(r.timedOut, true);
    assert.ok(Date.now() - started < 5000, "settled promptly via the deadline, did not hang");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("runOpenRouterStructured: a SYNCHRONOUS request failure (newline in the key → bad header) is caught, not a process crash (council Codex P1)", async () => {
  // a key containing a newline makes lib.request throw ERR_INVALID_CHAR synchronously; postJson must
  // catch it, clear the deadline (no leaked timer that later dereferences an un-initialized req), and
  // surface an error result — never crash the audit.
  registerOpenRouterKey("sk-bad\nInjected: header");
  const backends = { openrouter: { available: true, baseURL: "http://127.0.0.1:1", seats: [{ id: "or-x", model: "vendor/model" }] } };
  const r = await runOpenRouterStructured("/x", backends, { agentTimeoutMs: 500 }, "p", "or-x", {});
  assert.notEqual(r.status, 0, "a bad-header sync throw yields an error result");
  assert.notEqual(r.status, 124, "it is a synchronous transport error, not a wall-clock timeout");
  assert.ok(r.stderr && r.stderr.length > 0, "the error is surfaced");
  registerOpenRouterKey("sk-secret"); // restore for later tests
});

test("runOpenRouterStructured: content as an ARRAY OF PARTS is joined (OpenAI-compatible multimodal shape)", async () => {
  // a provider that replies with [{type:"text",text:"…"}] was treated as "no message content" → the seat
  // looked permanently dead while staying §6-required, so its missing vote vetoed every sensitive patch.
  registerOpenRouterKey("sk-secret");
  const body = JSON.stringify({
    choices: [{ message: { content: [{ type: "text", text: '{"agent":"or-x",' }, { type: "image_url", image_url: { url: "x" } }, { type: "text", text: '"findings":[]}' }] } }]
  });
  const r = await runOpenRouterStructured("/x", seatBackends(), {}, "p", "or-x", { transport: async () => ({ status: 200, body }) });
  assert.equal(r.status, 0, "array-of-parts content is accepted");
  assert.equal(r.stdout, '{"agent":"or-x","findings":[]}', "text parts are concatenated with no separator (the JSON re-forms); non-text parts contribute nothing");
});

test("runOpenRouterStructured: a reasoning model with EMPTY content falls back to message.reasoning / reasoning_content", async () => {
  registerOpenRouterKey("sk-secret");
  const reasoning = await runOpenRouterStructured("/x", seatBackends(), {}, "p", "or-x", {
    transport: async () => ({ status: 200, body: JSON.stringify({ choices: [{ message: { content: "", reasoning: '{"agent":"or-x","findings":[]}' } }] }) })
  });
  assert.equal(reasoning.status, 0, "content:'' + reasoning → usable");
  assert.match(reasoning.stdout, /findings/);

  const rc = await runOpenRouterStructured("/x", seatBackends(), {}, "p", "or-x", {
    transport: async () => ({ status: 200, body: JSON.stringify({ choices: [{ message: { content: null, reasoning_content: [{ type: "text", text: "VERDICT: APPROVE" }] } }] }) })
  });
  assert.equal(rc.status, 0, "content:null + reasoning_content (as parts) → usable");
  assert.equal(rc.stdout, "VERDICT: APPROVE");

  const both = await runOpenRouterStructured("/x", seatBackends(), {}, "p", "or-x", {
    transport: async () => ({ status: 200, body: JSON.stringify({ choices: [{ message: { content: "THE ANSWER", reasoning: "just my thinking" } }] }) })
  });
  assert.equal(both.stdout, "THE ANSWER", "content WINS when present — reasoning is only a fallback");
});

test("runOpenRouterStructured stays FAIL-CLOSED: a 2xx with nothing usable is still an error naming the SEAT", async () => {
  registerOpenRouterKey("sk-secret");
  for (const body of [JSON.stringify({ choices: [{ message: { content: "   " } }] }), JSON.stringify({ choices: [{ message: {} }] }), JSON.stringify({ choices: [] }), "not json at all"]) {
    const r = await runOpenRouterStructured("/x", seatBackends(), {}, "p", "or-x", { transport: async () => ({ status: 200, body }) });
    assert.notEqual(r.status, 0, `a 2xx with no usable content must NOT become a silent approval: ${body.slice(0, 30)}`);
    assert.equal(r.stdout, "", "no stdout → no vote");
    assert.match(r.stderr, /or-x/, "the DEAD SEAT is named in the error text (diagnosable)");
    assert.match(r.stderr, /vendor\/model/, "the model slug is named too");
  }
});

test("runOpenRouterStructured: finish_reason 'length' → truncated:true (a cut-off reply must not cast a full §6 vote)", async () => {
  registerOpenRouterKey("sk-secret");
  const cut = await runOpenRouterStructured("/x", seatBackends(), {}, "p", "or-x", {
    transport: async () => ({ status: 200, body: JSON.stringify({ choices: [{ finish_reason: "length", message: { content: "VERDICT: APPRO" } }] }) })
  });
  assert.equal(cut.truncated, true, "a model-truncated reply is marked truncated (the §6 reviewer then casts NO vote)");

  const native = await runOpenRouterStructured("/x", seatBackends(), {}, "p", "or-x", {
    transport: async () => ({ status: 200, body: JSON.stringify({ choices: [{ finish_reason: null, native_finish_reason: "MAX_TOKENS", message: { content: "partial" } }] }) })
  });
  assert.equal(native.truncated, true, "a provider's native truncation signal counts too");

  const complete = await runOpenRouterStructured("/x", seatBackends(), {}, "p", "or-x", {
    transport: async () => ({ status: 200, body: JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "VERDICT: APPROVE" } }] }) })
  });
  assert.equal(complete.truncated, false, "a normal 'stop' finish is NOT truncated");
  assert.equal(complete.status, 0);
});

test("runOpenRouterStructured: a 400 rejecting `temperature` is retried WITHOUT it (o-series/gpt-5 class is not permanently dead)", async () => {
  registerOpenRouterKey("sk-secret");
  const payloads = [];
  const transport = async (_url, payload) => {
    payloads.push(payload);
    if ("temperature" in payload) return { status: 400, body: JSON.stringify({ error: { message: "Unsupported value: 'temperature' does not support 0 with this model" } }) };
    return { status: 200, body: JSON.stringify({ choices: [{ message: { content: "ok" } }] }) };
  };
  const r = await runOpenRouterStructured("/x", seatBackends(), {}, "p", "or-x", { transport });
  assert.equal(r.status, 0, "the retry without temperature succeeds — the seat lives");
  assert.equal(r.stdout, "ok");
  assert.equal(payloads.length, 2);
  assert.equal(payloads[0].temperature, 0, "the first attempt still sends temperature:0 (unchanged default)");
  assert.equal("temperature" in payloads[1], false, "the offending field is dropped on the retry");
});

test("runOpenRouterStructured: the 400 fallback is PROGRESSIVE — reasoning first, then temperature", async () => {
  registerOpenRouterKey("sk-secret");
  const payloads = [];
  // a model that rejects BOTH extras with a generic 'unsupported parameter' body naming neither field
  const transport = async (_url, payload) => {
    payloads.push(payload);
    if ("reasoning" in payload || "temperature" in payload) return { status: 400, body: '{"error":{"message":"unsupported parameter"}}' };
    return { status: 200, body: JSON.stringify({ choices: [{ message: { content: "ok" } }] }) };
  };
  const backends = { openrouter: { available: true, baseURL: "https://openrouter.ai/api/v1", seats: [{ id: "or-x", model: "vendor/model", effort: "high" }] } };
  const r = await runOpenRouterStructured("/x", backends, {}, "p", "or-x", { transport });
  assert.equal(r.status, 0, "both offending fields are shed across ≤2 retries → the seat lives");
  assert.equal(payloads.length, 3);
  assert.deepEqual(payloads[0].reasoning, { effort: "high" });
  assert.equal(payloads[0].temperature, 0);
  assert.equal("reasoning" in payloads[1], false, "reasoning is dropped first");
  assert.equal(payloads[1].temperature, 0);
  assert.equal("temperature" in payloads[2], false, "then temperature");
});

test("runOpenRouterStructured: a 400 that is NOT a parameter rejection is surfaced as-is (no blind retry, classification intact)", async () => {
  registerOpenRouterKey("sk-secret");
  let calls = 0;
  const r = await runOpenRouterStructured("/x", seatBackends(), {}, "p", "or-x", {
    transport: async () => { calls += 1; return { status: 400, body: "context length exceeded for this request" }; }
  });
  assert.equal(calls, 1, "a genuine 400 is not masked by a retry");
  assert.equal(r.status, 400);
  assert.match(r.stderr, /status=400/, "the code is still surfaced for the retry classifier");
  assert.equal(isRateLimitError(`${r.stderr}`), false, "a 400 is not a transient rate-limit");
});

test("runOpenRouterStructured: a transport timeout → status 124 timedOut; a missing seat → skipped", async () => {
  registerOpenRouterKey("sk-secret");
  const r = await runOpenRouterStructured("/x", seatBackends(), {}, "p", "or-x", { transport: async () => { throw new Error("timeout"); } });
  assert.equal(r.status, 124);
  assert.equal(r.timedOut, true);
  const miss = await runOpenRouterStructured("/x", seatBackends(), {}, "p", "or-unknown", { transport: async () => ({ status: 200, body: "{}" }) });
  assert.equal(miss.skipped, true, "an unconfigured seat id is skipped, not run");
});
