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
    seen.add(id);
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
 * EXFIL GUARD (council Fable): a custom base URL is honored ONLY when the key was provided EXPLICITLY
 * (CLI/policy `openrouter_api_key`) or the host is loopback — never when the key comes from the user's
 * ENV and a (possibly repo-supplied) config points at a remote host, which would ship the env key to
 * an attacker. A custom base must also be https (or http://localhost for a local proxy).
 */
export function openRouterBackend(options = {}, env = process.env, explicitKeyArg = null) {
  const { seats, warnings } = normalizeOpenRouterModels(options.openrouterModels);
  const keyEnv = options.openrouterApiKeyEnv || "OPENROUTER_API_KEY";
  // The EXPLICIT (config/CLI) key is passed TRANSIENTLY (explicitKeyArg) so it never has to live on
  // the long-lived `options` object (which is spread + could be serialized/logged). options.openrouterApiKey
  // is still read as a fallback for direct callers/tests, but the production flow (council-companion)
  // passes it via the transient arg only.
  const explicitKey = (explicitKeyArg ? String(explicitKeyArg) : null) ?? (options.openrouterApiKey ? String(options.openrouterApiKey) : null);
  const envKey = env[keyEnv] ? String(env[keyEnv]) : null;
  const key = explicitKey ?? envKey ?? null;
  const keySource = explicitKey ? "explicit" : envKey ? "env" : null;

  let baseURL = DEFAULT_BASE_URL;
  const want = options.openrouterBaseUrl ? String(options.openrouterBaseUrl).trim().replace(/\/+$/, "") : null;
  if (want) {
    // Loopback (http OR https) is exfil-safe. The pattern is anchored + requires a :port, / or end
    // after the host, so a `http://127.0.0.1@evil.com` userinfo trick does NOT read as loopback.
    const isLoopback = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(want);
    const isHttps = /^https:\/\//i.test(want);
    if (!isHttps && !isLoopback) warnings.push("openrouter_base_url must be https (or http://localhost) — ignored");
    else if (keySource === "env" && !isLoopback) warnings.push("openrouter_base_url ignored: a custom remote host is not honored with an ENV-sourced key (exfil guard) — set openrouter_api_key explicitly to use it");
    else baseURL = want;
  }

  const available = Boolean(key) && seats.length > 0;
  registerOpenRouterKey(available ? key : null);
  return { available, seats, baseURL, apiKeyEnv: keyEnv, apiKeyPresent: Boolean(key), keySource, warnings };
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
    const req = lib.request(
      u,
      { method: "POST", headers: { "content-type": "application/json", "content-length": data.length, ...headers }, timeout: timeoutMs },
      (res) => {
        let body = "";
        let capped = false;
        res.on("data", (c) => {
          if (body.length < RESPONSE_CAP) body += c;
          else capped = true;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body, capped }));
      }
    );
    req.on("error", (e) => reject(e));
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
    // non-2xx: surface the code (status=<n> matches RATE_LIMIT_RE for transient; 401/quota → PERMANENT_RE)
    return buildAgentResult(seatId, "openrouter", { status: res.status || 1, stdout: "", stderr: scrub(`openrouter ${seat.model}: status=${res.status} ${String(res.body ?? "").slice(0, 300)}`), durationMs }, { model: seat.model });
  } catch (err) {
    const durationMs = deps.now ? deps.now() - started : null;
    const timedOut = /timeout/i.test(String(err?.message ?? ""));
    return buildAgentResult(seatId, "openrouter", { status: timedOut ? 124 : 1, stdout: "", stderr: scrub(`openrouter ${seat.model}: ${err?.message ?? err}`), timedOut, durationMs }, { model: seat.model });
  }
}
