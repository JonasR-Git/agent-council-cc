// OpenRouter (OpenAI-compatible) SEATS — run an arbitrary user-configured model as a council finder /
// §6 patch reviewer / refutation verifier via a plain HTTPS POST. ZERO runtime deps (node:https/http).
//
// SECURITY POSTURE: an OpenRouter seat spawns NO subprocess — no local shell/fs/exec/tools on the
// auditing machine — so it is strictly SAFER than a CLI seat (a prompt-injected reply can only shape
// text the existing fail-closed parsers already distrust; the nonce-fenced untrusted-data framing in
// the prompt builders is its sufficient defense). The consented trade-off is that reviewed repo source
// is sent to a third-party provider — the user opts in by configuring an API key. The API KEY lives
// ONLY in this module's scope: it is NEVER placed in `options` (which is spread widely and serialized
// into fix-loop/endless checkpoints), never returned, never logged, and is scrubbed from any surfaced
// error text.
import https from "node:https";
import http from "node:http";
import { buildAgentResult } from "./agents.mjs";

export const OPENROUTER_MAX_SEATS = 5;
const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
const RESPONSE_CAP = 10_000_000; // never buffer an unbounded body
const BUILTIN_IDS = new Set(["codex", "grok", "claude"]);

let REGISTERED_KEY = null;
/** Register the resolved key in module scope (never in options/results). Pass null to clear. */
export function registerOpenRouterKey(key) {
  REGISTERED_KEY = key && typeof key === "string" ? key : null;
}
function scrub(text) {
  const s = String(text ?? "");
  return REGISTERED_KEY ? s.split(REGISTERED_KEY).join("[redacted]") : s;
}

/**
 * Parse a configured model entry into { id, model, effort }.
 *   "anthropic/claude-3.5" | "id=anthropic/claude-3.5" | "id=anthropic/claude-3.5@high"
 *   or (from .council.json) { id, model|slug, effort }.
 * ids are sanitized to `or-[a-z0-9-]+`, built-in collisions are rejected, duplicates dropped, and the
 * list is HARD-CAPPED at OPENROUTER_MAX_SEATS. Returns { seats, warnings }.
 */
export function normalizeOpenRouterModels(list) {
  const seats = [];
  const warnings = [];
  const seen = new Set();
  const seenModels = new Set();
  const raws = Array.isArray(list) ? list : [];
  for (const raw of raws) {
    let id = "";
    let model = "";
    let effort;
    if (raw && typeof raw === "object") {
      model = String(raw.model ?? raw.slug ?? "").trim();
      id = String(raw.id ?? "").trim();
      effort = raw.effort ? String(raw.effort).trim() : undefined;
    } else if (typeof raw === "string") {
      const s = raw.trim();
      if (!s) continue;
      const at = s.split("@");
      effort = at[1] ? at[1].trim() : undefined;
      const lhs = at[0];
      if (lhs.includes("=")) {
        const eq = lhs.indexOf("=");
        id = lhs.slice(0, eq).trim();
        model = lhs.slice(eq + 1).trim();
      } else {
        model = lhs.trim();
      }
    } else {
      continue;
    }
    if (!model) {
      warnings.push(`openrouter model entry has no slug: ${JSON.stringify(raw)}`);
      continue;
    }
    if (!id) id = model;
    id = `or-${id.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}`.replace(/^or-or-/, "or-").slice(0, 48);
    if (id === "or-") {
      warnings.push(`openrouter model produced an empty id: ${model}`);
      continue;
    }
    if (BUILTIN_IDS.has(id.replace(/^or-/, ""))) {
      warnings.push(`openrouter seat id collides with a built-in seat: ${id}`);
      continue;
    }
    if (seen.has(id)) {
      warnings.push(`duplicate openrouter seat id dropped: ${id}`);
      continue;
    }
    // Deduplicate the canonical MODEL SLUG too (council Codex P2): two aliases for the identical model
    // would masquerade as two INDEPENDENT agents — matching findings could reach ≥2-agent "consensus"
    // and skip refutation, and §6/coverage would misreport duplicate calls as distinct seats.
    const modelKey = model.toLowerCase();
    if (seenModels.has(modelKey)) {
      warnings.push(`duplicate openrouter model slug dropped (already has a seat): ${model}`);
      continue;
    }
    seen.add(id);
    seenModels.add(modelKey);
    seats.push({ id, model, ...(effort ? { effort } : {}) });
    if (seats.length >= OPENROUTER_MAX_SEATS) {
      if (raws.length > OPENROUTER_MAX_SEATS) warnings.push(`openrouter seats hard-capped at ${OPENROUTER_MAX_SEATS} (extra entries dropped)`);
      break;
    }
  }
  return { seats, warnings };
}

/**
 * Resolve the NON-SECRET backend descriptor for OpenRouter, registering the key in module scope.
 * availability = a key is present AND ≥1 configured model. There is NO network probe — a dead network
 * just yields failed runs, which every consumer already treats fail-closed.
 *
 * EXFIL GUARD (council Fable/Claude/Codex): a custom base URL is honored ONLY when the host is LOOPBACK
 * (a local OpenAI-compatible proxy). A remote base_url is never honored — its only channel today is the
 * untrusted repo policy file, so redirecting the user's key/source to a repo-chosen remote host is the
 * exfil vector. A requested-but-rejected remote base DISABLES the backend fail-closed (available=false)
 * rather than silently retargeting the default host with a token meant for the user's own proxy.
 */
export function openRouterBackend(options = {}, env = process.env, userKeyArg = null) {
  const { seats, warnings } = normalizeOpenRouterModels(options.openrouterModels);
  const keyEnv = options.openrouterApiKeyEnv || "OPENROUTER_API_KEY";
  // TRUST MODEL (council OpenRouter Claude P1): the .council.yml is read from the AUDITED (untrusted)
  // repo, so a repo-supplied key/base could otherwise silently ship the working tree to an attacker's
  // OpenRouter account/host. Therefore the KEY only ever comes from a USER-level source: the ENV var
  // (recommended) or an explicit CLI flag threaded as userKeyArg — NEVER from the repo policy file.
  // (options.openrouterApiKey is honored only for direct callers/tests, not the CLI flow.) Repo config
  // can at most add MODEL SLUGS to an already-env-consented setup — egress needs the user's own key.
  const userKey = (userKeyArg ? String(userKeyArg) : null) ?? (options.openrouterApiKey ? String(options.openrouterApiKey) : null);
  const envKey = env[keyEnv] ? String(env[keyEnv]) : null;
  const key = userKey ?? envKey ?? null;

  // BASE URL: honor a custom base ONLY when it is LOOPBACK (a local OpenAI-compatible proxy — no exfil
  // risk). A REMOTE base_url is NEVER honored here, because the only channel for it today is the
  // untrusted repo policy file; redirecting the user's key to a repo-chosen remote host is the exfil
  // vector. The anchored loopback pattern rejects the `http://127.0.0.1@evil.com` userinfo trick.
  let baseURL = DEFAULT_BASE_URL;
  let baseRejected = false;
  const want = options.openrouterBaseUrl ? String(options.openrouterBaseUrl).trim().replace(/\/+$/, "") : null;
  if (want) {
    // Honor a custom base only when the host is LOOPBACK (a local proxy) or the canonical openrouter.ai
    // service itself. Both anchored patterns require the host to be immediately followed by `/` or end,
    // so the userinfo trick (…openrouter.ai@evil.com) and suffix trick (…openrouter.ai.evil.com) are
    // rejected. ANY OTHER host is refused.
    const isLoopback = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(want);
    const isOfficial = /^https:\/\/openrouter\.ai(:\d+)?(\/|$)/i.test(want);
    if (isLoopback || isOfficial) baseURL = want;
    else {
      // A requested-but-rejected base DISABLES the backend fail-closed (council Codex P1): silently
      // falling back to openrouter.ai would send the reviewed source — and the token the user meant for
      // their own proxy — to OpenRouter instead. Never redirect a rejected destination to the default.
      baseRejected = true;
      warnings.push("openrouter DISABLED: openrouter_base_url must be a loopback (localhost) proxy or the openrouter.ai host — a different remote host is refused (would send your key/source off-machine); OpenRouter is OFF for this run rather than silently retargeting the default host");
    }
  }

  const available = Boolean(key) && seats.length > 0 && !baseRejected;
  registerOpenRouterKey(available ? key : null);
  return { available, seats, baseURL, apiKeyEnv: keyEnv, apiKeyPresent: Boolean(key), keySource: key ? (userKey ? "user" : "env") : null, warnings };
}

/** Minimal node:https/http JSON POST → { status, body } (or throws on transport error). Injectable. */
function postJson(url, payload, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      reject(new Error(`invalid url: ${e.message}`));
      return;
    }
    const lib = u.protocol === "http:" ? http : https;
    const data = Buffer.from(JSON.stringify(payload), "utf8");
    let settled = false;
    // ABSOLUTE wall-clock deadline (council Codex P1): node's `timeout` option is only a SOCKET-INACTIVITY
    // timeout — a hostile/broken endpoint that dribbles one byte per interval keeps the request pending
    // forever and hangs the seat's Promise.all indefinitely. This hard deadline destroys the request no
    // matter what, so every seat settles within timeoutMs.
    const deadline = setTimeout(() => {
      if (!settled) req.destroy(new Error("timeout"));
    }, Math.max(1, Number(timeoutMs) || 300_000));
    if (typeof deadline.unref === "function") deadline.unref();
    const done = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      fn(arg);
    };
    const req = lib.request(
      u,
      { method: "POST", headers: { "content-type": "application/json", "content-length": data.length, ...headers }, timeout: timeoutMs },
      (res) => {
        let body = "";
        let capped = false;
        res.on("data", (c) => {
          if (body.length < RESPONSE_CAP) body += c;
          else if (!capped) {
            // response exceeds the cap → stop reading and abort immediately rather than draining an
            // unbounded (possibly adversarial) body to 'end'.
            capped = true;
            res.destroy();
            done(resolve, { status: res.statusCode ?? 0, body, capped });
          }
        });
        res.on("error", (e) => done(reject, e));
        res.on("end", () => done(resolve, { status: res.statusCode ?? 0, body, capped }));
      }
    );
    req.on("error", (e) => done(reject, e));
    req.on("timeout", () => {
      req.destroy(new Error("timeout"));
    });
    req.end(data);
  });
}

/**
 * Run an OpenRouter seat with a full prompt (structured output expected). Maps the HTTP outcome onto
 * the EXACT runner result contract every consumer honors (status/stdout/stderr/timedOut/truncated), via
 * buildAgentResult. 2xx + a content string → status 0, stdout = content. A 429/503/… body → stderr
 * carrying "status=<code>" (matches audit-retry's RATE_LIMIT_RE so the cell scheduler backs off); a
 * 401/quota body hits PERMANENT_RE and is never retried. `deps.transport(url,payload,headers,timeoutMs)`
 * is injectable for tests (no network). The key is read from module scope, never from options.
 */
export async function runOpenRouterStructured(cwd, backends, options, prompt, seatId, deps = {}) {
  const seat = (backends?.openrouter?.seats ?? []).find((s) => s.id === seatId);
  if (!seat) return buildAgentResult(seatId, "openrouter", { status: 1, stdout: "", stderr: `no openrouter seat configured: ${seatId}` }, { skipped: true });
  const baseURL = backends?.openrouter?.baseURL ?? DEFAULT_BASE_URL;
  const key = REGISTERED_KEY;
  if (!key) return buildAgentResult(seatId, "openrouter", { status: 1, stdout: "", stderr: "openrouter: no API key registered" }, {});

  const transport = deps.transport ?? postJson;
  const effort = options?.openrouterEffort ?? seat.effort;
  const started = deps.now ? deps.now() : 0;
  const doPost = (withReasoning) =>
    transport(
      `${baseURL}/chat/completions`,
      { model: seat.model, messages: [{ role: "user", content: String(prompt ?? "") }], temperature: 0, ...(withReasoning && effort ? { reasoning: { effort } } : {}) },
      { authorization: `Bearer ${key}`, "http-referer": "https://github.com/agent-council", "x-title": "agent-council" },
      Number(options?.agentTimeoutMs) || 300_000
    );

  try {
    let res = await doPost(Boolean(effort));
    // one-shot retry WITHOUT the reasoning field for models that reject it (mirrors grok's fallback)
    if (effort && res.status === 400 && /reasoning|effort|unsupported|invalid/i.test(res.body || "")) {
      res = await doPost(false);
    }
    const durationMs = deps.now ? deps.now() - started : null;
    if (res.status >= 200 && res.status < 300) {
      let content = "";
      try {
        content = JSON.parse(res.body)?.choices?.[0]?.message?.content ?? "";
      } catch {
        content = "";
      }
      if (typeof content !== "string" || content === "") {
        return buildAgentResult(seatId, "openrouter", { status: 1, stdout: "", stderr: scrub(`openrouter ${seat.model}: 2xx with no message content`), durationMs, truncated: Boolean(res.capped) }, { model: seat.model });
      }
      return buildAgentResult(seatId, "openrouter", { status: 0, stdout: content, stderr: "", durationMs, truncated: Boolean(res.capped) }, { model: seat.model });
    }
    // non-2xx: surface the code (status=<n> matches RATE_LIMIT_RE for transient; 401/quota → PERMANENT_RE).
    // SCRUB the FULL body BEFORE truncating (council Codex P2): slicing first could keep a partial key that
    // then fails the exact-match redaction and leaks the prefix into stderr/logs.
    return buildAgentResult(seatId, "openrouter", { status: res.status || 1, stdout: "", stderr: `openrouter ${seat.model}: status=${res.status} ${scrub(String(res.body ?? "")).slice(0, 300)}`, durationMs }, { model: seat.model });
  } catch (err) {
    const durationMs = deps.now ? deps.now() - started : null;
    const timedOut = /timeout/i.test(String(err?.message ?? ""));
    return buildAgentResult(seatId, "openrouter", { status: timedOut ? 124 : 1, stdout: "", stderr: scrub(`openrouter ${seat.model}: ${err?.message ?? err}`), timedOut, durationMs }, { model: seat.model });
  }
}
