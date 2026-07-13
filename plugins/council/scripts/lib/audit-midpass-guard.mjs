// B — the CHECKPOINT-AND-RESUME mid-pass quota guard. This is the responsiveness core: instead of
// letting a grouped review burn a whole ~1500-cell pass before the between-pass guard ever runs, we
// check quota BEFORE dispatching each cell (cheap: local files + one light OAuth GET, zero model
// tokens) and, on a breach, FINISH the in-flight cell, QUIESCE (stop scheduling new cells), flush
// partial findings + a durable cursor, and hand the loop a `quiesced` marker it turns into the SAME
// hard-stop / pause the between-pass path emits. It is checkpoint-and-resume, NOT abort-with-loss.
//
// SSOT: the ceiling/pause DECISION reuses evaluateBetweenPassGuards (audit-loop-guards.mjs) verbatim —
// this module never reimplements ceiling/pause logic. It ADDS exactly two things the between-pass path
// doesn't need: (1) a PRE-DISPATCH headroom margin so overshoot is bounded to the in-flight cell(s)
// rather than a whole pass, and (2) a fail-soft TTL for the HARD ceiling: usage unreadable/stale beyond
// the TTL must quiesce new PAID work (a hard stop can't fail-soft forever). The SOFT 5h pause stays
// purely fail-soft — it never quiesces on unknown/stale usage.

import fs from "node:fs";
import path from "node:path";

import { evaluateBetweenPassGuards } from "./audit-loop-guards.mjs";

// How stale the last USABLE ceiling reading may get before the hard ceiling quiesces new paid work.
// A few minutes: long enough that a transient reader blip fails soft, short enough that a persistently
// unreadable ceiling can't run unbounded. Named + exported so both branches are pinned + testable.
export const USAGE_TTL_MS = 4 * 60e3;
// Re-read usage at most this often during a pass — a cell is ~3s so a 90s cadence is ~free while still
// catching a breach within one cadence window. The pre-dispatch check also runs on the FIRST cell.
export const GUARD_EVERY_MS = 90e3;
// Pre-dispatch safety margin (percent points) below the ceiling: start a cell only if usage is more than
// this under the ceiling, so a breach is caught BEFORE it happens and overshoot is bounded to in-flight.
export const DEFAULT_HEADROOM_PCT = 2;

const MODELS = ["claude", "codex", "grok"];

/**
 * Does the snapshot carry a USABLE ceiling reading — i.e. at least one model that is CONFIGURED in the
 * ceiling, AVAILABLE, and has a finite weekPercent (a number that could actually breach)? An
 * all-unavailable / all-null snapshot is "readable but unknown" (fail-soft, never quiesces within TTL);
 * only a snapshot that COULD breach resets the staleness clock. PURE.
 */
export function snapshotHasUsableCeiling(snapshot, usageCeiling) {
  if (!usageCeiling || typeof usageCeiling !== "object") return false;
  const snap = snapshot && typeof snapshot === "object" ? snapshot : {};
  for (const model of MODELS) {
    if (usageCeiling[model] == null) continue;
    const m = snap[model];
    if (m && typeof m === "object" && m.available === true && Number.isFinite(Number(m.weekPercent))) return true;
  }
  return false;
}

/**
 * The PURE mid-pass decision. Given a snapshot, the ceiling/pause config, and how long it's been since a
 * USABLE ceiling reading (`usableAgeMs`), decide whether to QUIESCE before the next cell. Reuses
 * evaluateBetweenPassGuards for the ceiling/pause logic (SSOT). Returns:
 *   { quiesce: null | {kind}, decision }
 * where `quiesce.kind` is one of:
 *   - "stale-ceiling": a ceiling is configured AND no usable reading within the TTL → quiesce paid work
 *     (the hard stop can't fail-soft forever). NEVER fires for a pause-only config.
 *   - "ceiling": an available model is at/over its (headroom-reduced) ceiling → pre-empt the breach.
 *   - "pause": the soft 5h pause tripped mid-pass (carries the SAME `pause` object the between-pass path
 *     builds, so the loop emits the identical contract).
 * `decision` is the raw evaluateBetweenPassGuards output for the caller that also wants it.
 */
export function evaluateMidPassGuard({
  usageCeiling = null,
  pause5h = null,
  snapshot = null,
  usableAgeMs = 0,
  ttlMs = USAGE_TTL_MS,
  headroomPct = DEFAULT_HEADROOM_PCT,
  nowMs = Date.now(),
  prevWindowSig = null,
  madeProgress = false,
  pauseIdSeed = ""
} = {}) {
  // 1) HARD-ceiling fail-soft TTL. Only when a ceiling is actually configured — a pause-only run stays
  //    purely fail-soft and never quiesces on unknown/stale usage.
  if (usageCeiling && usableAgeMs > ttlMs) {
    return { quiesce: { kind: "stale-ceiling", ageMs: usableAgeMs, ttlMs }, decision: { ceiling: null, pause: null } };
  }
  // 2) PRE-DISPATCH headroom: evaluate the ceiling at (ceiling - headroom) so we stop just BEFORE the
  //    real breach, bounding overshoot to the in-flight cell(s). Reuses evaluateBetweenPassGuards →
  //    evaluateCeiling (fail-soft inherited: unavailable/null never breaches).
  const preCeiling = usageCeiling
    ? Object.fromEntries(Object.entries(usageCeiling).map(([k, v]) => [k, Math.max(1, Math.floor(Number(v) - headroomPct))]))
    : null;
  const decision = evaluateBetweenPassGuards({
    usageCeiling: preCeiling,
    pause5h,
    snapshot,
    nowMs,
    prevWindowSig,
    madeProgress,
    pauseIdSeed
  });
  if (decision.ceiling?.breached) {
    // Relabel each breach's `ceiling` back to the REAL configured value (+ headroom) so the stop message
    // is honest ("39% approaching 40% ceiling, headroom 2"), not the reduced internal threshold.
    const breaches = decision.ceiling.breaches.map((b) => ({
      ...b,
      ceiling: usageCeiling[b.model] ?? b.ceiling,
      headroomPct,
      preempt: Number(b.percent) < Number(usageCeiling[b.model] ?? b.ceiling)
    }));
    return { quiesce: { kind: "ceiling", breaches }, decision };
  }
  if (decision.pause) return { quiesce: { kind: "pause", pause: decision.pause }, decision };
  return { quiesce: null, decision };
}

// ---------------------------------------------------------------------------------------------------
// Durable reviewed-cell CURSOR: the checkpoint half of checkpoint-and-resume. Each completed cell's
// stable key is appended (durably) to a cursor file so a --resume after a mid-pass quiesce SKIPS the
// cells already reviewed — no double-charge, no lost cells. Ordering contract (enforced by the caller):
// the cell's findings are flushed to the durable store BEFORE its key is marked here, so a crash between
// the two re-reviews the cell (findings re-append, deduped) rather than skipping an unrecorded one.
// ---------------------------------------------------------------------------------------------------

/** Absolute path of the reviewed-cell cursor for a run's state dir. */
export function reviewCursorPath(stateDir) {
  return path.join(stateDir, "audit-review-cursor.jsonl");
}

/**
 * A durable set of completed cell keys. Load seeds from any existing cursor (a --resume). `markDone(key)`
 * appends the key (fsync) so it survives a crash; `isDone(key)` is the resume-skip test; `reset()` clears
 * it for a fresh (non-resume) pass. A torn trailing key in the cursor is harmless: it won't match any real
 * cell, so at worst ONE reviewed cell is re-charged — never a skipped un-reviewed cell. `deps.*` injectable.
 */
export function makeReviewCursor(file, { deps = {} } = {}) {
  const readFileSync = deps.readFileSync ?? fs.readFileSync;
  const openSync = deps.openSync ?? fs.openSync;
  const writeSync = deps.writeSync ?? fs.writeSync;
  const fsyncSync = deps.fsyncSync ?? fs.fsyncSync;
  const closeSync = deps.closeSync ?? fs.closeSync;
  const rmSync = deps.rmSync ?? ((f) => fs.rmSync(f, { force: true }));
  const mkdirSync = deps.mkdirSync ?? ((d) => fs.mkdirSync(d, { recursive: true }));

  const done = new Set();
  const load = () => {
    done.clear();
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      return;
    }
    if (typeof text !== "string" || !text) return;
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i].trim();
      if (!line) continue;
      // Each line is `{"k":"<cellKey>"}`. A torn trailing line just fails to parse → skip it (safe: an
      // unrecorded key means its cell is simply re-reviewed).
      try {
        const rec = JSON.parse(line);
        if (rec && typeof rec.k === "string") done.add(rec.k);
      } catch {
        /* torn/blank → skip; never throws (a re-review is the safe failure direction) */
      }
    }
  };
  load();

  return {
    isDone: (key) => done.has(key),
    size: () => done.size,
    keys: () => [...done],
    markDone(key) {
      if (typeof key !== "string" || done.has(key)) return;
      done.add(key);
      try {
        mkdirSync(path.dirname(file));
        const fd = openSync(file, "a");
        try {
          writeSync(fd, `${JSON.stringify({ k: key })}\n`);
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
      } catch {
        /* cursor persistence is best-effort for REVIEW; fixing gates durability via requireDurableStore */
      }
    },
    reset() {
      done.clear();
      try {
        rmSync(file);
      } catch {
        /* ignore */
      }
    },
    reload: load
  };
}

/**
 * The stateful RUNTIME guard the cell scheduler consults per cell. It owns:
 *   - the reviewed-cell cursor (isDone → resume-skip; markDone → after the store flush),
 *   - a cached usage snapshot refreshed at most every GUARD_EVERY_MS (reads are coalesced so N inflight
 *     cells trigger ONE read), tracking the last USABLE ceiling reading for the TTL,
 *   - a sticky `quiesce` reason: once tripped, every subsequent beforeCell returns stop immediately so
 *     no new cell is dispatched (in-flight cells finish → overshoot bounded to them).
 * `readUsage` is injectable; `usageCeiling`/`pause5h` are the run's real config; `now` is injectable for
 * tests. `madeProgress`/`prevWindowSig`/`pauseIdSeed` thread the anti-thrash context so a mid-pass pause
 * builds the SAME pause object the between-pass path would.
 */
export function makeMidPassGuard({
  cursor = null,
  readUsage = null,
  usageCeiling = null,
  pause5h = null,
  now = () => Date.now(),
  guardEveryMs = GUARD_EVERY_MS,
  ttlMs = USAGE_TTL_MS,
  headroomPct = DEFAULT_HEADROOM_PCT,
  prevWindowSig = null,
  madeProgress = null,
  pauseIdSeed = "",
  // P2b: the RUN-level baseline of the hard-ceiling stale-TTL clock — the last time usage was USABLE this
  // run (or the run start). The guard is rebuilt per pass, so without seeding this the staleness clock
  // would reset every ~<2min pass and the "a hard ceiling cannot fail-soft forever" quiesce could never
  // fire under the default small-pass loop. runFixLoop persists it in the checkpoint and re-seeds it each
  // pass; null (a bare guard) falls back to this instance's startedAtMs, unchanged for a one-shot review.
  staleSinceMs = null
} = {}) {
  const startedAtMs = now();
  const state = {
    quiesce: null,
    snapshot: null,
    lastUsableAtMs: Number.isFinite(staleSinceMs) ? staleSinceMs : null,
    lastReadAtMs: null,
    reading: null
  };
  const active = Boolean(readUsage) && (Boolean(usageCeiling) || Boolean(pause5h));

  async function refresh() {
    if (!state.reading) {
      state.reading = (async () => {
        try {
          const snap = await readUsage();
          state.snapshot = snap;
          if (snapshotHasUsableCeiling(snap, usageCeiling)) state.lastUsableAtMs = now();
        } catch {
          // A read failure keeps the last snapshot; lastUsableAtMs does NOT advance → the TTL clock grows
          // and eventually quiesces for the ceiling (never for a pause-only run).
        } finally {
          state.lastReadAtMs = now();
          state.reading = null;
        }
      })();
    }
    await state.reading;
  }

  return {
    active,
    get quiesce() {
      return state.quiesce;
    },
    // P2b: expose the current last-usable-usage timestamp so runFixLoop can carry it back to the run
    // level and re-checkpoint it after each pass (the stale-TTL clock is RUN-wide, not per-pass).
    get lastUsableAtMs() {
      return state.lastUsableAtMs;
    },
    isDone(cell) {
      return cursor ? cursor.isDone(cell) : false;
    },
    markDone(cell) {
      if (cursor) cursor.markDone(cell);
    },
    /**
     * PRE-DISPATCH check. Returns true to QUIESCE (do not start this cell). Sticky: once quiesced, always
     * true. Fail-soft: any unexpected error here returns false (never blocks review on a guard bug); the
     * TTL/ceiling quiesce is a deliberate `true`, not a thrown error.
     */
    async beforeCell() {
      if (!active) return false;
      if (state.quiesce) return true;
      try {
        const t = now();
        if (state.lastReadAtMs == null || t - state.lastReadAtMs >= guardEveryMs) await refresh();
        // Staleness accrues from the last USABLE reading, or — never yet usable this run — from the
        // run-level baseline seeded via staleSinceMs (falling back to this pass's startedAtMs for a bare
        // guard). Both fallbacks are finite, so the age is always a real number (no dead Infinity branch).
        const usableAgeMs = t - (state.lastUsableAtMs ?? startedAtMs);
        const res = evaluateMidPassGuard({
          usageCeiling,
          pause5h,
          snapshot: state.snapshot,
          usableAgeMs,
          ttlMs,
          headroomPct,
          nowMs: t,
          prevWindowSig,
          madeProgress: typeof madeProgress === "function" ? Boolean(madeProgress()) : Boolean(madeProgress),
          pauseIdSeed
        });
        if (res.quiesce) {
          state.quiesce = res.quiesce;
          return true;
        }
        return false;
      } catch {
        return false; // a guard bug must never stop the review; the ceiling TTL path returns true, not throws
      }
    }
  };
}
