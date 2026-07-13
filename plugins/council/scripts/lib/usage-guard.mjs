// Per-model usage guard for the autonomous `audit fix --loop`: turns the three
// CLIs' real provider QUOTA % (Claude 5h/7d via OAuth, Codex weekly, Grok weekly)
// into (a) a `--usage-ceiling` the loop STOPS on and (b) a snapshot the live
// dashboard renders. FAIL-SOFT is load-bearing: reading usage must NEVER change a
// command's outcome — a reader/network failure degrades a model to "unavailable",
// and the ceiling STOPS the loop ONLY on a CONFIRMED breach (a model that IS
// available AND is at/over its ceiling), NEVER on unknown/unavailable usage.
//
// parseUsageCeiling + evaluateCeiling are PURE; readUsageSnapshot is the one I/O
// function and its `readers` are injectable so tests need no fs/network.

import path from "node:path";

import { collectAllTokenUsage, collectCodexRateLimits, collectGrokLimits, fetchClaudeLimits } from "./token-usage.mjs";

// The user-approved defaults when `--usage-ceiling` is given without a value.
export const DEFAULT_CEILING = Object.freeze({ claude: 40, codex: 50, grok: 40 });

const MODELS = ["claude", "codex", "grok"];

// A finite number in [1,100], else null (used as a "no usable value" signal).
const finitePct = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const numOr0 = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/**
 * Parse a `--usage-ceiling` value into `{ claude, codex, grok }` (each 1..100).
 * Forms (a missing model always falls back to its DEFAULT_CEILING value):
 *  - null/undefined/"" → the full default `{ claude:40, codex:50, grok:40 }`.
 *  - "45"              → all three = 45.
 *  - "40/50/40"        → claude/codex/grok, in that order (exactly 3 values).
 *  - "claude=40,codex=50,grok=40" → keyed, any subset; unspecified → default.
 * Throws a clear Error on an out-of-range (not 1..100) or unparseable value, or an
 * unknown model key. PURE.
 */
export function parseUsageCeiling(input) {
  const defaults = { ...DEFAULT_CEILING };
  if (input == null) return defaults;
  const raw = String(input).trim();
  if (raw === "") return defaults;

  const validate = (rawVal, label) => {
    const s = String(rawVal).trim();
    if (s === "") throw new Error(`--usage-ceiling: ${label} is empty (expected a number 1..100)`);
    const v = Number(s);
    if (!Number.isFinite(v)) throw new Error(`--usage-ceiling: ${label} must be a number 1..100 (got "${rawVal}")`);
    if (v < 1 || v > 100) throw new Error(`--usage-ceiling: ${label} must be between 1 and 100 (got ${v})`);
    return v;
  };

  // Keyed form: "claude=40,codex=50" (any subset; unspecified stays at default).
  if (raw.includes("=")) {
    const out = { ...defaults };
    for (const part of raw.split(",")) {
      const seg = part.trim();
      if (!seg) continue;
      const eq = seg.indexOf("=");
      if (eq === -1) throw new Error(`--usage-ceiling: expected model=value in "${seg}"`);
      const key = seg.slice(0, eq).trim().toLowerCase();
      if (!MODELS.includes(key)) throw new Error(`--usage-ceiling: unknown model "${key}" (expected claude/codex/grok)`);
      out[key] = validate(seg.slice(eq + 1), key);
    }
    return out;
  }

  // Slash form: "40/50/40" (claude/codex/grok, exactly three values).
  if (raw.includes("/")) {
    const parts = raw.split("/");
    if (parts.length !== 3) throw new Error(`--usage-ceiling: slash form needs exactly 3 values claude/codex/grok (got "${raw}")`);
    return { claude: validate(parts[0], "claude"), codex: validate(parts[1], "codex"), grok: validate(parts[2], "grok") };
  }

  // Single number: apply to all three.
  const v = validate(raw, "value");
  return { claude: v, codex: v, grok: v };
}

// The default readers wrap the token-usage.mjs functions (real fs/OAuth). Tests
// inject fakes with the SAME signatures so they need no filesystem or network.
const DEFAULT_READERS = { fetchClaudeLimits, collectCodexRateLimits, collectGrokLimits, collectAllTokenUsage };

// Pick whichever of Codex's two rate-limit windows is the weekly one (the spec's
// contract is primary===weekly, but honor a layout where it's secondary instead).
function codexWeeklyWindow(cd) {
  if (!cd || typeof cd !== "object") return null;
  for (const w of [cd.primary, cd.secondary]) {
    if (w && typeof w === "object" && w.window === "weekly") return w;
  }
  return cd.primary && typeof cd.primary === "object" ? cd.primary : null;
}

/**
 * Read a normalized per-model usage snapshot. `readers` is injectable (defaults
 * wrap token-usage.mjs). Returns:
 *   { claude:{available,weekPercent,fiveHourPercent,weekResetsAt,tokens:{out,in,total}},
 *     codex: {available,weekPercent,weekResetsAt,tokens:{out,in,total}},
 *     grok:  {available,weekPercent,weekResetsAt,tokens:{total}} }
 * FAIL-SOFT per model: a quota reader that throws or returns {error}/null leaves
 * that model `available:false` with null percents — it NEVER throws the whole
 * snapshot. Token reading is independent (its own try/catch, degrading to zeros)
 * and never affects a model's availability.
 */
export async function readUsageSnapshot({ homeDir, sinceMs, readers } = {}) {
  const R = readers && typeof readers === "object" ? readers : DEFAULT_READERS;
  const home = homeDir ?? "";

  // Tokens: one call, fail-soft to zeros. A token-read failure must NOT flip a
  // model to unavailable (availability is strictly about the QUOTA reader).
  let tokens = {};
  try {
    if (typeof R.collectAllTokenUsage === "function") {
      const t = await R.collectAllTokenUsage({ homeDir: home, sinceMs });
      if (t && typeof t === "object") tokens = t;
    }
  } catch {
    /* fail-soft: tokens degrade to zeros */
  }
  const cTok = tokens.claude ?? {};
  const xTok = tokens.codex ?? {};
  const gTok = tokens.grok ?? {};

  const claude = {
    available: false,
    weekPercent: null,
    fiveHourPercent: null,
    weekResetsAt: null,
    tokens: { out: numOr0(cTok.outputTokens), in: numOr0(cTok.inputTokens), total: numOr0(cTok.inputTokens) + numOr0(cTok.outputTokens) }
  };
  try {
    if (typeof R.fetchClaudeLimits === "function") {
      const c = await R.fetchClaudeLimits(path.join(home, ".claude"));
      if (c && typeof c === "object" && !c.error) {
        claude.available = true;
        claude.weekPercent = finitePct(c.sevenDay?.usedPercent);
        claude.fiveHourPercent = finitePct(c.fiveHour?.usedPercent);
        claude.weekResetsAt = c.sevenDay?.resetsAt ?? null;
      }
    }
  } catch {
    /* fail-soft: claude stays unavailable */
  }

  const codex = {
    available: false,
    weekPercent: null,
    weekResetsAt: null,
    tokens: { out: numOr0(xTok.outputTokens), in: numOr0(xTok.inputTokens), total: numOr0(xTok.totalTokens) }
  };
  try {
    if (typeof R.collectCodexRateLimits === "function") {
      const x = await R.collectCodexRateLimits(path.join(home, ".codex"));
      if (x && typeof x === "object" && !x.error) {
        const weekly = codexWeeklyWindow(x);
        codex.available = true;
        codex.weekPercent = finitePct(weekly?.usedPercent);
        codex.weekResetsAt = weekly?.resetsAt ?? null;
      }
    }
  } catch {
    /* fail-soft: codex stays unavailable */
  }

  const grok = {
    available: false,
    weekPercent: null,
    weekResetsAt: null,
    tokens: { total: numOr0(gTok.totalTokens) }
  };
  try {
    if (typeof R.collectGrokLimits === "function") {
      const g = await R.collectGrokLimits(path.join(home, ".grok"));
      if (g && typeof g === "object" && !g.error) {
        grok.available = true;
        grok.weekPercent = finitePct(g.usedPercent);
        grok.weekResetsAt = g.resetsAt ?? null;
      }
    }
  } catch {
    /* fail-soft: grok stays unavailable */
  }

  return { claude, codex, grok };
}

/**
 * Evaluate a snapshot against a ceiling. Returns `{ breached, breaches, unavailable }`.
 * A breach is recorded ONLY for a model that is `available` AND has a numeric
 * weekPercent at/over its ceiling — `{ model, window:"weekly", percent, ceiling }`.
 * Claude additionally breaches on its 5h window (an earlier signal against the SAME
 * claude ceiling): `{ model:"claude", window:"5h", ... }`. A model with
 * `available:false` (or no numeric percent) is NEVER a breach — the guard can never
 * stop on unknown usage — but its name is collected in `unavailable`. PURE.
 */
export function evaluateCeiling(snapshot, ceiling) {
  const snap = snapshot && typeof snapshot === "object" ? snapshot : {};
  const c = ceiling && typeof ceiling === "object" ? ceiling : {};
  const breaches = [];
  const unavailable = [];
  for (const model of MODELS) {
    const m = snap[model];
    if (!m || typeof m !== "object" || m.available !== true) {
      unavailable.push(model);
      continue;
    }
    const limit = finitePct(c[model]);
    if (limit == null) continue; // no ceiling configured for this model → can't breach
    const week = finitePct(m.weekPercent);
    if (week != null && week >= limit) breaches.push({ model, window: "weekly", percent: week, ceiling: limit });
    if (model === "claude") {
      const fiveH = finitePct(m.fiveHourPercent);
      if (fiveH != null && fiveH >= limit) breaches.push({ model: "claude", window: "5h", percent: fiveH, ceiling: limit });
    }
  }
  return { breached: breaches.length > 0, breaches, unavailable };
}
