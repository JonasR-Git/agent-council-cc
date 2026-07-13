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

// D (fail-soft hole): a provider window whose reset timestamp is a VALID time clearly in the PAST beyond
// a small grace is STALE — its percent is from a bygone window that has ALREADY reset, so it must never
// drive a guard (for guard purposes stale == unknown). `graceMs` absorbs clock skew + a just-passed reset
// (aligned with evaluatePause5h's just-reset grace). Conservative on purpose: a MISSING/unparseable
// timestamp, or one in the FUTURE / within grace, is NOT stale — so FRESH data behaves exactly as before.
const STALE_WINDOW_GRACE_MS = 15 * 60e3;
function windowIsStale(resetsAt, nowMs, graceMs = STALE_WINDOW_GRACE_MS) {
  if (resetsAt == null) return false;
  const ms = Date.parse(resetsAt);
  if (!Number.isFinite(ms)) return false;
  return ms < nowMs - graceMs;
}

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

// Codex ALSO reports a 5h window (window_minutes 300) alongside the weekly one — it just sits in
// primary OR secondary depending on which is the constraining window at that moment. Pick it by label
// (null when the latest snapshot has no active 5h window, e.g. just after a 5h reset).
function codexFiveHourWindow(cd) {
  if (!cd || typeof cd !== "object") return null;
  for (const w of [cd.primary, cd.secondary]) {
    if (w && typeof w === "object" && w.window === "5h") return w;
  }
  return null;
}

/**
 * Read a normalized per-model usage snapshot. `readers` is injectable (defaults
 * wrap token-usage.mjs). Returns:
 *   { claude:{available,weekPercent,fiveHourPercent,weekResetsAt,fiveHourResetsAt,tokens:{out,in,total}},
 *     codex: {available,weekPercent,fiveHourPercent,weekResetsAt,fiveHourResetsAt,tokens:{out,in,total}},
 *     grok:  {available,weekPercent,weekResetsAt,tokens:{total}} }
 * (Grok has no 5h window → no fiveHour* fields; Codex's fiveHourPercent/fiveHourResetsAt are null when
 * the latest snapshot has no active 5h window. fiveHourResetsAt is the resume clock for `--pause-at-5h`.)
 * FAIL-SOFT per model: a quota reader that throws or returns {error}/null leaves
 * that model `available:false` with null percents — it NEVER throws the whole
 * snapshot. Token reading is independent (its own try/catch, degrading to zeros)
 * and never affects a model's availability.
 */
export async function readUsageSnapshot({ homeDir, sinceMs, readers, nowMs = Date.now() } = {}) {
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
    fiveHourResetsAt: null,
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
        claude.fiveHourResetsAt = c.fiveHour?.resetsAt ?? null;
      }
    }
  } catch {
    /* fail-soft: claude stays unavailable */
  }

  const codex = {
    available: false,
    weekPercent: null,
    fiveHourPercent: null,
    weekResetsAt: null,
    fiveHourResetsAt: null,
    tokens: { out: numOr0(xTok.outputTokens), in: numOr0(xTok.inputTokens), total: numOr0(xTok.totalTokens) }
  };
  try {
    if (typeof R.collectCodexRateLimits === "function") {
      const x = await R.collectCodexRateLimits(path.join(home, ".codex"));
      if (x && typeof x === "object" && !x.error) {
        const weekly = codexWeeklyWindow(x);
        const fiveH = codexFiveHourWindow(x);
        codex.available = true;
        codex.weekPercent = finitePct(weekly?.usedPercent);
        codex.fiveHourPercent = finitePct(fiveH?.usedPercent);
        codex.weekResetsAt = weekly?.resetsAt ?? null;
        codex.fiveHourResetsAt = fiveH?.resetsAt ?? null;
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

  // D: drop any STALE window's percent (+ its stale reset) so BOTH guards fail-soft on it — evaluateCeiling
  // never breaches on a null weekPercent and evaluatePause5h never pauses on a null fiveHourPercent. This
  // is the SSOT for staleness: the pure evaluators stay untouched and inherit it. Only past-grace windows
  // are dropped; `available` stays true (the provider IS reachable — just THIS window's number is dead).
  for (const m of [claude, codex, grok]) {
    if (windowIsStale(m.weekResetsAt, nowMs)) {
      m.weekPercent = null;
      m.weekResetsAt = null;
    }
    if ("fiveHourResetsAt" in m && windowIsStale(m.fiveHourResetsAt, nowMs)) {
      m.fiveHourPercent = null;
      m.fiveHourResetsAt = null;
    }
  }

  return { claude, codex, grok };
}

/**
 * Evaluate a snapshot against a ceiling. Returns `{ breached, breaches, unavailable }`.
 * `--usage-ceiling` is the WEEKLY HARD STOP and NOTHING else: a breach is recorded ONLY for a model
 * that is `available` AND has a numeric WEEKLY `weekPercent` at/over its ceiling —
 * `{ model, window:"weekly", percent, ceiling }`. The 5h window is DELIBERATELY not evaluated here:
 * it is a soft PAUSE (evaluatePause5h below), a separate policy that resets in hours, never a terminal
 * ceiling stop. A model with `available:false` (or no numeric weekPercent) is NEVER a breach — the
 * guard can never stop on unknown usage — but its name is collected in `unavailable`. PURE.
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
  }
  return { breached: breaches.length > 0, breaches, unavailable };
}

/**
 * Parse a `--pause-at-5h` value into `{ enabled, threshold(1..100), autonomous }`. The 5h SOFT PAUSE
 * is ON BY DEFAULT at 85% (the user's explicit safety rule): a plain `audit fix --loop` already pauses
 * between passes when an available model's 5h window is ≥ 85%, with a manual-resume contract. Forms:
 *  - null/undefined/"" (ABSENT flag)  → { enabled:true,  threshold:85, autonomous:false }  (DEFAULT ON)
 *  - "off" | "none" | "0" | "false"   → { enabled:false, threshold:85, autonomous:false }  (turn OFF)
 *  - "<N>" (1..100)                   → { enabled:true,  threshold:N,  autonomous:false }  (retune)
 *  - "auto" | "auto:<N>" | "<N>:auto" → { enabled:true,  threshold:N||85, autonomous:true } (AUTONOMOUS:
 *                                        the loop waits in-process to the reset then resumes itself)
 * Throws on an out-of-range/unparseable threshold. PURE.
 */
export function parsePause5hOption(input) {
  const DEFAULT = 85;
  if (input == null) return { enabled: true, threshold: DEFAULT, autonomous: false };
  const raw = String(input).trim().toLowerCase();
  if (raw === "") return { enabled: true, threshold: DEFAULT, autonomous: false };
  if (raw === "off" || raw === "none" || raw === "false" || raw === "0") {
    return { enabled: false, threshold: DEFAULT, autonomous: false };
  }

  const validate = (s) => {
    const v = Number(s);
    if (!Number.isFinite(v)) throw new Error(`--pause-at-5h: threshold must be a number 1..100 (got "${s}")`);
    if (v < 1 || v > 100) throw new Error(`--pause-at-5h: threshold must be between 1 and 100 (got ${v})`);
    return v;
  };

  // AUTONOMOUS forms carry the word "auto" (alone, or paired with a threshold in either order).
  if (raw.includes("auto")) {
    const parts = raw.split(":").map((s) => s.trim()).filter((s) => s !== "");
    const nums = parts.filter((s) => s !== "auto");
    // The only non-numeric token allowed alongside "auto" is nothing — reject e.g. "autox" / "auto:hi".
    if (nums.some((s) => !Number.isFinite(Number(s)))) {
      throw new Error(`--pause-at-5h: unrecognized value "${raw}" (expected off | <N> | auto | auto:<N>)`);
    }
    return { enabled: true, threshold: nums.length ? validate(nums[0]) : DEFAULT, autonomous: true };
  }

  return { enabled: true, threshold: validate(raw), autonomous: false };
}

/**
 * Evaluate a snapshot's 5h windows against a soft-pause `threshold`. This is the `--pause-at-5h`
 * policy — a SEPARATE, softer thing than `--usage-ceiling` (weekly hard stop): the 5h window resets in
 * hours, so pausing + resuming across it is useful, never terminal. PURE, TOTAL, fail-soft. Returns:
 *   { paused, blockers:[{model,percent,threshold,resetsAt}], schedulable, resumeAt:ISO|null, reason }
 * Rules:
 *  - A blocker is ONLY an AVAILABLE model with a FINITE fiveHourPercent ≥ threshold (unavailable /
 *    null-5h → never a blocker; Grok has no 5h window). No blocker → paused:false, reason:"none".
 *  - resumeAt = max(blocker.resetsAt) + bufferMs, schedulable:true — but ONLY when that latest reset is
 *    a VALID timestamp that is either in the future within maxAheadMs, OR just-reset in the immediate
 *    past (within justResetGraceMs → resumable-now, resumeAt = now + bufferMs). A missing/invalid,
 *    genuinely stale (old past), or absurdly-far (> now + maxAheadMs) reset → schedulable:false,
 *    resumeAt:null, reason:"unschedulable-timestamp" (the caller MANUAL-stops — it must never
 *    auto-schedule a dead/indefinite/absurd wait, even in autonomous mode).
 */
export function evaluatePause5h(
  snapshot,
  threshold,
  { nowMs = Date.now(), bufferMs = 120000, maxAheadMs = 5 * 3600e3 + 15 * 60e3, justResetGraceMs = 15 * 60e3 } = {}
) {
  const snap = snapshot && typeof snapshot === "object" ? snapshot : {};
  const t = finitePct(threshold);
  const blockers = [];
  if (t != null) {
    for (const model of MODELS) {
      const m = snap[model];
      if (!m || typeof m !== "object" || m.available !== true) continue;
      const fiveH = finitePct(m.fiveHourPercent);
      if (fiveH != null && fiveH >= t) blockers.push({ model, percent: fiveH, threshold: t, resetsAt: m.fiveHourResetsAt ?? null });
    }
  }
  if (blockers.length === 0) return { paused: false, blockers: [], schedulable: false, resumeAt: null, reason: "none" };

  // Resume clock = the LATEST breaching reset (a resume before the last window clears would just
  // re-pause). Only schedule against a timestamp we can trust.
  let maxResetMs = null;
  for (const b of blockers) {
    const ms = b.resetsAt == null ? NaN : Date.parse(b.resetsAt);
    if (Number.isFinite(ms) && (maxResetMs == null || ms > maxResetMs)) maxResetMs = ms;
  }
  const unschedulable = { paused: true, blockers, schedulable: false, resumeAt: null, reason: "unschedulable-timestamp" };
  if (maxResetMs == null) return unschedulable; // every breaching reset was missing/invalid
  if (maxResetMs > nowMs + maxAheadMs) return unschedulable; // absurdly far (wrong/rolled clock)
  if (maxResetMs <= nowMs) {
    // Past reset: a JUST-reset window is resumable-now (short buffer); an old/stale timestamp is not
    // trustworthy → manual stop, never a blind resume on ancient data.
    if (nowMs - maxResetMs <= justResetGraceMs) {
      return { paused: true, blockers, schedulable: true, resumeAt: new Date(nowMs + bufferMs).toISOString(), reason: "ok" };
    }
    return unschedulable;
  }
  return { paused: true, blockers, schedulable: true, resumeAt: new Date(maxResetMs + bufferMs).toISOString(), reason: "ok" };
}
