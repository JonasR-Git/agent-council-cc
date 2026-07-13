import { interpolate, loadPrompt, makeFenceNonce } from "./agents.mjs";
import { extractJsonObject, SEVERITY_RANK } from "./findings.mjs";
import { SCHEMAS } from "./schemas.mjs";
import { makeSeatRunners } from "./seats.mjs";
import { validate } from "./validate.mjs";

const MAX_ENTRIES_PER_ROUND = 6;
const MAX_ROUNDS = 2;
const DEBATE_MAX_TURNS = 10;

/**
 * The stance of a reply that never arrived (seat skipped / no runner) or could not be parsed. It is
 * NOT one of the three real stances: an absent reply must never be laundered into a "defend" that
 * reads exactly like a real one (and pays for a round-2 counter against an argument nobody made).
 */
export const NO_REPLY_STANCE = "no-reply";

export function normalizeStance(value) {
  const stance = String(value ?? "").toLowerCase().trim();
  if (stance === "concede" || stance === "revise" || stance === "defend") {
    return stance;
  }
  return "defend";
}

/** Fail-closed rebuttal: no stance was taken, so none is invented; the item stays contested. */
function noReplyRebuttal(agent, id, reason, validationErrors = []) {
  return {
    id,
    agent,
    stance: NO_REPLY_STANCE,
    note: "",
    revisedSeverity: null,
    parseOk: false,
    failed: true,
    failureReason: reason,
    validationErrors
  };
}

/**
 * Fail-closed counter: an absent/unparseable counter must never read as a WITHDRAWN critique, so the
 * critique still stands (upheld) — but `failed` marks it, so no report renders it as a real reply.
 */
function noReplyCounter(agent, id, reason, validationErrors = []) {
  return {
    id,
    agent,
    upheld: true,
    note: "",
    parseOk: false,
    failed: true,
    failureReason: reason,
    validationErrors
  };
}

function parseDebateRebuttal(stdout, agent, id) {
  const doc = extractJsonObject(stdout);
  const checked = validate(SCHEMAS.debateRebuttal, doc);
  if (!checked.valid) {
    return noReplyRebuttal(agent, id, "unparseable reply", checked.errors);
  }
  // Trust the CALLER's id, never the model-echoed doc.id (anti-spoofing convention used elsewhere,
  // e.g. findings.mjs ignores doc.agent and trusts only the runner's identity): a diverging/empty
  // echoed id would otherwise make applyDebateOutcomes' byId lookup miss and silently drop a real
  // concede/revise.
  return {
    id: String(id),
    agent,
    stance: normalizeStance(doc.stance),
    note: String(doc.note ?? "").trim(),
    revisedSeverity: doc.revisedSeverity ?? null,
    parseOk: true,
    failed: false,
    failureReason: null,
    validationErrors: []
  };
}

function parseDebateCounter(stdout, agent, id) {
  const doc = extractJsonObject(stdout);
  const checked = validate(SCHEMAS.debateCounter, doc);
  if (!checked.valid) {
    return noReplyCounter(agent, id, "unparseable reply", checked.errors);
  }
  // Trust the CALLER's id, never the model-echoed doc.id — same anti-spoofing rationale as
  // parseDebateRebuttal above.
  return {
    id: String(id),
    agent,
    upheld: Boolean(doc.upheld),
    note: String(doc.note ?? "").trim(),
    parseOk: true,
    failed: false,
    failureReason: null,
    validationErrors: []
  };
}

function debateOptions(options) {
  return {
    ...options,
    maxTurns: DEBATE_MAX_TURNS,
    grokEffort: options.r2Effort ?? options.grokEffort
  };
}

/**
 * Route an agent to ITS OWN seat runner (codex/grok/claude/or-*), via the dynamic seat registry.
 * NEVER fall back to another seat: routing every non-codex agent to grok made grok write claude's /
 * an OpenRouter seat's rebuttal, which the report then attributed to that seat — a fabricated
 * attribution. A seat with no runner is skipped honestly instead (fail-closed).
 */
function runAgentPrompt(agent, cwd, backends, options, prompt, deps = {}) {
  const run = makeSeatRunners(cwd, backends, options, deps)[agent];
  if (!run) {
    return Promise.resolve({
      agent,
      skipped: true,
      reason: `no runner for seat ${agent}`,
      stdout: "",
      stderr: ""
    });
  }
  return run(prompt);
}

// Both prompts interpolate finding/diff-derived text (ITEM_JSON) and, for the counter, a peer
// model's free-text critique (REBUTTAL_NOTE) — the same untrusted-data shape every other
// model/repo-content prompt in this codebase fences with a one-time nonce (r1-independent,
// r2-peer-critique, r2-plan-critique, r1-proposal, r2-verify, buildReformatPrompt). Without it, a
// reviewed diff containing instruction-like text quoted verbatim into a finding's `detail` could be
// fed unframed to the author/critic model.
function buildRebuttalPrompt(entry) {
  const template = loadPrompt("debate-rebuttal");
  return interpolate(template, {
    AGENT: entry.author,
    ITEM_ID: entry.id,
    ITEM_JSON: JSON.stringify(entry.payload, null, 2),
    NONCE: makeFenceNonce()
  });
}

function buildCounterPrompt(entry, rebuttal) {
  const template = loadPrompt("debate-counter");
  return interpolate(template, {
    AGENT: entry.critic,
    AUTHOR: entry.author,
    ITEM_ID: entry.id,
    ITEM_JSON: JSON.stringify(entry.payload, null, 2),
    REBUTTAL_NOTE: rebuttal?.note ?? "(no note)",
    NONCE: makeFenceNonce()
  });
}

/**
 * Bounded, moderated debate — NOT a live chat. Round 1: the disputed item's
 * author defends/concedes/revises once, with minimal context. Round 2 (opt-in):
 * the original critic responds once to defended items. Hard caps everywhere.
 */
export async function runDebateRounds(cwd, backends, options, entries, deps = {}) {
  const rounds = Math.min(Number(options.debateRounds ?? 0), MAX_ROUNDS);
  if (!rounds || !entries?.length) {
    return [];
  }

  const results = [];
  const capped = [...entries]
    .sort(
      (a, b) =>
        (SEVERITY_RANK[a.payload?.severity] ?? 2) - (SEVERITY_RANK[b.payload?.severity] ?? 2)
    )
    .slice(0, MAX_ENTRIES_PER_ROUND);
  const opts = debateOptions(options);

  const rebuttals = await Promise.all(
    capped.map(async (entry) => {
      // Grok authors argue in their own R1 session when debate_resume is on;
      // codex has no thread-precise resume (companion only supports resume-last).
      const resume = Boolean(
        options.debateResume && entry.author === "grok" && entry.authorSessionId
      );
      const res = await runAgentPrompt(
        entry.author,
        cwd,
        backends,
        resume ? { ...opts, resumeSessionId: entry.authorSessionId } : opts,
        buildRebuttalPrompt(entry),
        deps
      );
      // A skipped seat never argued: record a no-reply, never a stance it did not take.
      const parsed = res.skipped
        ? noReplyRebuttal(entry.author, entry.id, res.reason ?? "seat skipped")
        : parseDebateRebuttal(res.stdout, entry.author, entry.id);
      return {
        ...res,
        ...parsed,
        round: 1,
        role: "rebuttal",
        resumedSession: resume,
        skipped: Boolean(res.skipped),
        artifactRound: `debate-${entry.id}`
      };
    })
  );
  results.push(...rebuttals);

  if (rounds >= 2) {
    // Only a REAL defend earns a counter — a no-reply (skipped seat / unparseable) is not an
    // argument to counter, and paying a second agent call to rebut it was pure waste.
    const defended = capped.filter((entry, i) => {
      const rebuttal = rebuttals[i];
      return rebuttal.parseOk && rebuttal.stance === "defend" && entry.critic && entry.critic !== entry.author;
    });
    const counters = await Promise.all(
      defended.map(async (entry) => {
        const rebuttal = rebuttals.find((r) => r.id === entry.id);
        // Grok critics resume their own R2 critique session when debate_resume
        // is on, so counters carry the critic's original reasoning context.
        const resume = Boolean(
          options.debateResume && entry.critic === "grok" && entry.criticSessionId
        );
        const res = await runAgentPrompt(
          entry.critic,
          cwd,
          backends,
          resume ? { ...opts, resumeSessionId: entry.criticSessionId } : opts,
          buildCounterPrompt(entry, rebuttal),
          deps
        );
        const parsed = res.skipped
          ? noReplyCounter(entry.critic, entry.id, res.reason ?? "seat skipped")
          : parseDebateCounter(res.stdout, entry.critic, entry.id);
        return {
          ...res,
          ...parsed,
          round: 2,
          role: "counter",
          resumedSession: resume,
          skipped: Boolean(res.skipped),
          artifactRound: `debate-${entry.id}`
        };
      })
    );
    results.push(...counters);
  }

  return results;
}

/**
 * Fold debate outcomes back into the merged findings: concede -> nit and no
 * longer contested; revise -> adopt revised severity when valid.
 */
export function applyDebateOutcomes(merged, debates) {
  if (!debates?.length) {
    return merged;
  }
  const byId = new Map();
  for (const d of debates) {
    if (d.round === 1) {
      byId.set(d.id, d);
    }
  }
  const counterById = new Map();
  for (const d of debates) {
    if (d.round === 2) {
      counterById.set(d.id, d);
    }
  }

  const validSeverities = new Set(["P0", "P1", "P2", "nit"]);
  const all = merged.all.map((item) => {
    const rebuttal = (item.ids ?? []).map((id) => byId.get(id)).find(Boolean);
    if (!rebuttal) {
      return item;
    }
    const counter = counterById.get(rebuttal.id) ?? null;
    const next = {
      ...item,
      debate: {
        stance: rebuttal.stance,
        note: rebuttal.note,
        failed: Boolean(rebuttal.failed),
        counter: counter
          ? { upheld: counter.upheld, note: counter.note, failed: Boolean(counter.failed) }
          : null
      }
    };
    // Fail-closed: a no-reply changes NOTHING (severity + contested stay as the council left them).
    if (rebuttal.failed) {
      return next;
    }
    if (rebuttal.stance === "concede") {
      next.severity = "nit";
      next.contested = false;
    } else if (rebuttal.stance === "revise" && validSeverities.has(rebuttal.revisedSeverity)) {
      next.severity = rebuttal.revisedSeverity;
    }
    return next;
  });

  return {
    ...merged,
    all,
    consensus: all.filter((item) => item.consensus),
    unique: all.filter((item) => !item.consensus)
  };
}

export function renderDebateSection(debates) {
  const lines = [];
  lines.push("## Debate (bounded, contested items only)");
  const rebuttals = debates.filter((d) => d.round === 1);
  const counters = new Map(debates.filter((d) => d.round === 2).map((d) => [d.id, d]));
  for (const r of rebuttals) {
    // A failed/absent reply is rendered as what it is — never as a stance the seat never took.
    lines.push(
      r.failed
        ? `- **${r.id}** ${r.agent} -> **no reply** (${r.failureReason ?? "unparseable"}) - item stays contested (fail-closed)`
        : `- **${r.id}** ${r.agent}${r.resumedSession ? " (resumed own R1 session)" : ""} -> **${r.stance}**${r.revisedSeverity ? ` (revised: ${r.revisedSeverity})` : ""}: ${r.note || "(no note)"}`
    );
    const counter = counters.get(r.id);
    if (counter) {
      lines.push(
        counter.failed
          ? `  - counter by ${counter.agent}: **no reply** (${counter.failureReason ?? "unparseable"}) - critique stands (fail-closed)`
          : `  - counter by ${counter.agent}: ${counter.upheld ? "upholds critique" : "withdraws critique"} - ${counter.note || "(no note)"}`
      );
    }
  }
  lines.push("");
  return lines.join("\n");
}
