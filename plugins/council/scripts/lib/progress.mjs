// Shared progress model + reporter for every long-running council command
// (audit review/fix/loop/endless, plan, build, deliberate). This is the WRITER
// side of the frozen progress.json contract (schemaVersion 1) that the live
// dashboard / markdown renderers READ. Pure + injectable: now() and
// writeFile(path, str) are injected so unit tests need no clock or filesystem
// (defaults wrap Date + node:fs for real callers). FAIL-SOFT throughout: a
// telemetry write (or clock/logSink) failure must NEVER break the command —
// progress is best-effort, the work is not.

import fs from "node:fs";
import path from "node:path";

export const PROGRESS_SCHEMA_VERSION = 1;
export const PROGRESS_FILE = "progress.json";
const DEFAULT_MAX_RECENT_LINES = 12;

function defaultNow() {
  return new Date().toISOString();
}

function defaultWriteFile(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data, "utf8");
}

/**
 * The empty schemaVersion-1 progress state every run starts from.
 * progress/counters/findingsByLens start EMPTY (not zero-filled): a field only
 * appears once actually reported, so the reader can tell "not measured" from a
 * real 0. A zero-filled default made a plan run that reports no units still
 * render a 0/0 bar and five 0 counters (the writer lying about progress).
 */
export function initialProgressState({ kind = null, title = null, jobId = null, startedAt = null } = {}) {
  return {
    schemaVersion: PROGRESS_SCHEMA_VERSION,
    kind,
    jobId,
    title,
    startedAt,
    updatedAt: startedAt,
    phase: null,
    phaseDetail: null,
    seats: [],
    progress: {},
    counters: {},
    findingsByLens: {},
    gate: null,
    budget: null,
    etaMs: null,
    recentLines: [],
    done: false,
    ok: null,
    stopReason: null
  };
}

/** The severity buckets a lens finding is aggregated into (order = display order). */
export const SEVERITY_BUCKETS = ["P0", "P1", "P2", "nit"];

/** Map an arbitrary severity string onto one bucket (unknown -> "nit"). */
function severityBucket(raw) {
  const s = String(raw ?? "").trim().toUpperCase();
  return s === "P0" || s === "P1" || s === "P2" ? s : "nit";
}

/**
 * Pure reducer: fold one progress event into a state and return the NEW state
 * (the input is never mutated). Events carry `at` (the updatedAt stamp; a null
 * `at` keeps the previous stamp so a broken clock never corrupts the state).
 * Unknown event types stamp updatedAt and change nothing else.
 */
export function mergeProgressEvent(state, event) {
  const base = state && typeof state === "object" ? state : initialProgressState();
  const e = event && typeof event === "object" ? event : {};
  const next = { ...base, updatedAt: e.at ?? base.updatedAt ?? null };

  switch (e.type) {
    case "phase":
      next.phase = e.phase ?? next.phase;
      // A new phase invalidates the previous phase's detail: omitted -> null.
      next.phaseDetail = e.detail ?? null;
      break;
    case "seat": {
      const name = String(e.name ?? "");
      const patch = e.patch && typeof e.patch === "object" ? e.patch : {};
      const seats = Array.isArray(base.seats) ? base.seats.slice() : [];
      const idx = seats.findIndex((s) => s && s.name === name);
      if (idx === -1) {
        seats.push({ name, state: "idle", unitsDone: 0, unitsTotal: 0, raised: 0, ...patch, name });
      } else {
        seats[idx] = { ...seats[idx], ...patch, name };
      }
      next.seats = seats;
      break;
    }
    case "counter": {
      const key = String(e.key ?? "");
      if (!key) break;
      // Null-proto accumulator so a counter literally keyed "__proto__"/"constructor" is stored
      // as a normal own key — a plain {} would route the assignment through the __proto__ setter
      // and silently drop the counter (or reparent the map).
      const counters = Object.assign(Object.create(null), base.counters && typeof base.counters === "object" ? base.counters : {});
      const delta = Number.isFinite(e.delta) ? e.delta : 1;
      counters[key] = (Number.isFinite(counters[key]) ? counters[key] : 0) + delta;
      next.counters = counters;
      break;
    }
    case "gate":
      // null clears the gate; a patch merges into the current gate (or starts one).
      next.gate = e.gate == null ? null : { ...(base.gate && typeof base.gate === "object" ? base.gate : {}), ...e.gate };
      break;
    case "progress":
      next.progress = {
        ...(base.progress && typeof base.progress === "object" ? base.progress : {}),
        ...(e.patch && typeof e.patch === "object" ? e.patch : {})
      };
      break;
    case "findings": {
      // Fold a batch of completed-unit findings into the live per-lens matrix
      // (findingsByLens[lens] = {total, P0, P1, P2, nit}) and, if a seat is
      // named, bump that seat's `raised` by the batch size. Every finding is
      // counted even if its lens/severity is junk (bucketed to other/nit).
      const list = Array.isArray(e.list) ? e.list : [];
      // Null-proto accumulator so a lens/category literally named "__proto__"/"constructor" lands
      // as a normal own key instead of hitting the prototype setter (which would reparent the map
      // or silently drop the finding).
      const byLens = Object.assign(Object.create(null), base.findingsByLens && typeof base.findingsByLens === "object" ? base.findingsByLens : {});
      let count = 0;
      for (const f of list) {
        if (!f || typeof f !== "object") continue;
        const lens = (String(f.lens ?? f.category ?? "other").trim() || "other").slice(0, 40);
        const bucket = severityBucket(f.severity);
        const prev = byLens[lens] && typeof byLens[lens] === "object" ? byLens[lens] : { total: 0, P0: 0, P1: 0, P2: 0, nit: 0 };
        const cell = { total: 0, P0: 0, P1: 0, P2: 0, nit: 0, ...prev };
        cell.total += 1;
        cell[bucket] += 1;
        byLens[lens] = cell;
        count += 1;
      }
      next.findingsByLens = byLens;
      if (e.seat != null && count > 0) {
        const name = String(e.seat);
        const seats = Array.isArray(base.seats) ? base.seats.slice() : [];
        const idx = seats.findIndex((s) => s && s.name === name);
        if (idx === -1) {
          seats.push({ name, state: "idle", unitsDone: 0, unitsTotal: 0, raised: count });
        } else {
          const prevRaised = Number.isFinite(seats[idx].raised) ? seats[idx].raised : 0;
          seats[idx] = { ...seats[idx], raised: prevRaised + count, name };
        }
        next.seats = seats;
      }
      break;
    }
    case "budget":
      next.budget = { spent: e.spent ?? 0, total: e.total ?? 0 };
      break;
    case "eta":
      next.etaMs = Number.isFinite(e.ms) ? e.ms : null;
      break;
    case "line": {
      const lines = Array.isArray(base.recentLines) ? base.recentLines.slice() : [];
      lines.push(String(e.line ?? ""));
      const cap = Number.isInteger(e.max) && e.max > 0 ? e.max : DEFAULT_MAX_RECENT_LINES;
      next.recentLines = lines.length > cap ? lines.slice(lines.length - cap) : lines;
      break;
    }
    case "done":
      next.done = true;
      next.ok = e.ok ?? null;
      next.stopReason = e.stopReason ?? null;
      // Terminal phase mirrors the outcome; ok=null (unknown) still reads "done".
      next.phase = e.ok === false ? "failed" : "done";
      break;
    default:
      break;
  }
  return next;
}

/**
 * A do-nothing reporter with the exact method surface of a real one, so lib
 * functions can write `const reporter = options.reporter ?? NOOP_REPORTER`
 * and call it unconditionally — zero null-checks, zero behavior change when
 * no reporter is wired. Every method is chainable; snapshot() returns null
 * (there is no state to snapshot).
 */
export const NOOP_REPORTER = Object.freeze({
  phase() {
    return NOOP_REPORTER;
  },
  seat() {
    return NOOP_REPORTER;
  },
  counter() {
    return NOOP_REPORTER;
  },
  gate() {
    return NOOP_REPORTER;
  },
  progress() {
    return NOOP_REPORTER;
  },
  findings() {
    return NOOP_REPORTER;
  },
  budget() {
    return NOOP_REPORTER;
  },
  eta() {
    return NOOP_REPORTER;
  },
  line() {
    return NOOP_REPORTER;
  },
  done() {
    return NOOP_REPORTER;
  },
  snapshot() {
    return null;
  }
});

/**
 * Wrap a reporter so it forwards every live signal EXCEPT findings folding. Used when an inner
 * review runs inside a larger loop that ALREADY folds that pass's deduped findings itself (the
 * endless loop calls reporter.findings(fresh) per pass): letting the inner review also fold its
 * per-unit findings would DOUBLE-COUNT into findingsByLens. Phase/seat/progress/gate/counter/line
 * (and budget/eta) still drive the live dashboard so per-unit/cell progress advances inside a pass;
 * `.findings()` is a no-op. snapshot() delegates to the wrapped reporter. Chainable like a real one.
 */
export function mutedFindingsReporter(reporter) {
  const base = reporter ?? NOOP_REPORTER;
  const wrapper = {
    phase: (...a) => (base.phase(...a), wrapper),
    seat: (...a) => (base.seat(...a), wrapper),
    counter: (...a) => (base.counter(...a), wrapper),
    gate: (...a) => (base.gate(...a), wrapper),
    progress: (...a) => (base.progress(...a), wrapper),
    findings: () => wrapper, // muted: the outer loop folds this pass's findings itself
    budget: (...a) => (base.budget(...a), wrapper),
    eta: (...a) => (base.eta(...a), wrapper),
    line: (...a) => (base.line(...a), wrapper),
    done: (...a) => (base.done(...a), wrapper),
    snapshot: () => base.snapshot()
  };
  return wrapper;
}

/**
 * Create the shared progress reporter a long-running command feeds. Every
 * mutating call merges into the in-memory state, stamps updatedAt via now(),
 * and persists the snapshot to `${stateDir}/progress.json` via writeFile —
 * fail-soft (a write throw is swallowed; the reporter keeps working). With no
 * stateDir the reporter is in-memory only. logSink(msg) receives every .line
 * verbatim (byte-compatible with today's onProgress stderr lines); the CLI
 * passes (m) => console.error(m), the default is a no-op.
 */
export function makeProgressReporter({
  kind = null,
  title = null,
  jobId = null,
  stateDir = null,
  now = defaultNow,
  writeFile = defaultWriteFile,
  logSink = () => {},
  maxRecentLines = DEFAULT_MAX_RECENT_LINES
} = {}) {
  const safeNow = () => {
    try {
      return now();
    } catch {
      return null; // broken clock -> keep the previous stamp (fail-soft)
    }
  };
  const file = stateDir ? `${String(stateDir).replace(/[\\/]+$/, "")}/${PROGRESS_FILE}` : null;
  let state = initialProgressState({ kind, title, jobId, startedAt: safeNow() });

  const persist = () => {
    if (!file) return;
    try {
      writeFile(file, `${JSON.stringify(state, null, 2)}\n`);
    } catch {
      /* fail-soft: telemetry must never break the command */
    }
  };

  const reporter = {};
  const apply = (event) => {
    state = mergeProgressEvent(state, { ...event, at: safeNow() });
    persist();
    return reporter;
  };

  reporter.phase = (name, detail) => apply({ type: "phase", phase: name, detail });
  reporter.seat = (name, patch) => apply({ type: "seat", name, patch });
  reporter.counter = (key, delta = 1) => apply({ type: "counter", key, delta });
  reporter.gate = (patch) => apply({ type: "gate", gate: patch });
  reporter.progress = (patch) => apply({ type: "progress", patch });
  // Aggregate a completed unit's/cell's findings into the live per-lens matrix.
  // `opts.seat` (optional) also bumps that seat's raised count by the batch size.
  reporter.findings = (list, { seat = null } = {}) => apply({ type: "findings", list, seat });
  reporter.budget = (spent, total) => apply({ type: "budget", spent, total });
  reporter.eta = (ms) => apply({ type: "eta", ms });
  reporter.line = (msg) => {
    try {
      logSink(msg); // verbatim - byte-compatible with today's onProgress
    } catch {
      /* fail-soft: a broken sink must not break the command */
    }
    return apply({ type: "line", line: msg, max: maxRecentLines });
  };
  reporter.done = ({ ok = null, stopReason = null } = {}) => apply({ type: "done", ok, stopReason });
  /** Deep copy of the current state - safe to hand out, never aliases internals. */
  reporter.snapshot = () => structuredClone(state);

  persist(); // announce the run immediately so watchers see it from second zero
  return reporter;
}
