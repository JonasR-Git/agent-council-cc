import { interpolate, loadPrompt, runCodexStructured, runGrokStructured } from "./agents.mjs";
import { extractJsonObject } from "./findings.mjs";
import { SCHEMAS } from "./schemas.mjs";
import { validate } from "./validate.mjs";

const MAX_ENTRIES_PER_ROUND = 6;
const MAX_ROUNDS = 2;
const DEBATE_MAX_TURNS = 10;

export function normalizeStance(value) {
  const stance = String(value ?? "").toLowerCase().trim();
  if (stance === "concede" || stance === "revise" || stance === "defend") {
    return stance;
  }
  return "defend";
}

export function parseDebateRebuttal(stdout, agent, id) {
  const doc = extractJsonObject(stdout);
  const checked = validate(SCHEMAS.debateRebuttal, doc);
  if (!checked.valid) {
    return {
      id,
      agent,
      stance: "defend",
      note: "",
      revisedSeverity: null,
      parseOk: false,
      validationErrors: checked.errors
    };
  }
  return {
    id: String(doc.id ?? id),
    agent,
    stance: normalizeStance(doc.stance),
    note: String(doc.note ?? "").trim(),
    revisedSeverity: doc.revisedSeverity ?? null,
    parseOk: true,
    validationErrors: []
  };
}

export function parseDebateCounter(stdout, agent, id) {
  const doc = extractJsonObject(stdout);
  const checked = validate(SCHEMAS.debateCounter, doc);
  if (!checked.valid) {
    return {
      id,
      agent,
      upheld: true,
      note: "",
      parseOk: false,
      validationErrors: checked.errors
    };
  }
  return {
    id: String(doc.id ?? id),
    agent,
    upheld: Boolean(doc.upheld),
    note: String(doc.note ?? "").trim(),
    parseOk: true,
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

function runAgentPrompt(agent, cwd, backends, options, prompt, label) {
  if (agent === "codex") {
    return runCodexStructured(cwd, backends, options, prompt, label);
  }
  return runGrokStructured(cwd, backends, options, prompt);
}

function buildRebuttalPrompt(entry) {
  const template = loadPrompt("debate-rebuttal");
  return interpolate(template, {
    AGENT: entry.author,
    ITEM_ID: entry.id,
    ITEM_JSON: JSON.stringify(entry.payload, null, 2)
  });
}

function buildCounterPrompt(entry, rebuttal) {
  const template = loadPrompt("debate-counter");
  return interpolate(template, {
    AGENT: entry.critic,
    AUTHOR: entry.author,
    ITEM_ID: entry.id,
    ITEM_JSON: JSON.stringify(entry.payload, null, 2),
    REBUTTAL_NOTE: rebuttal?.note ?? "(no note)"
  });
}

/**
 * Bounded, moderated debate — NOT a live chat. Round 1: the disputed item's
 * author defends/concedes/revises once, with minimal context. Round 2 (opt-in):
 * the original critic responds once to defended items. Hard caps everywhere.
 */
export async function runDebateRounds(cwd, backends, options, entries) {
  const rounds = Math.min(Number(options.debateRounds ?? 0), MAX_ROUNDS);
  if (!rounds || !entries?.length) {
    return [];
  }

  const results = [];
  const severityRank = { P0: 0, P1: 1, P2: 2, nit: 3 };
  const capped = [...entries]
    .sort(
      (a, b) =>
        (severityRank[a.payload?.severity] ?? 2) - (severityRank[b.payload?.severity] ?? 2)
    )
    .slice(0, MAX_ENTRIES_PER_ROUND);
  const opts = debateOptions(options);

  const rebuttals = await Promise.all(
    capped.map(async (entry) => {
      const res = await runAgentPrompt(
        entry.author,
        cwd,
        backends,
        opts,
        buildRebuttalPrompt(entry),
        `debate-${entry.id}`
      );
      const parsed = parseDebateRebuttal(res.skipped ? "" : res.stdout, entry.author, entry.id);
      return {
        ...res,
        ...parsed,
        round: 1,
        role: "rebuttal",
        skipped: Boolean(res.skipped),
        artifactRound: `debate-${entry.id}`
      };
    })
  );
  results.push(...rebuttals);

  if (rounds >= 2) {
    const defended = capped.filter((entry, i) => {
      const rebuttal = rebuttals[i];
      return rebuttal.stance === "defend" && entry.critic && entry.critic !== entry.author;
    });
    const counters = await Promise.all(
      defended.map(async (entry) => {
        const rebuttal = rebuttals.find((r) => r.id === entry.id);
        const res = await runAgentPrompt(
          entry.critic,
          cwd,
          backends,
          opts,
          buildCounterPrompt(entry, rebuttal),
          `debate-counter-${entry.id}`
        );
        const parsed = parseDebateCounter(res.skipped ? "" : res.stdout, entry.critic, entry.id);
        return {
          ...res,
          ...parsed,
          round: 2,
          role: "counter",
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
        counter: counter ? { upheld: counter.upheld, note: counter.note } : null
      }
    };
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
    lines.push(`- **${r.id}** ${r.agent} -> **${r.stance}**${r.revisedSeverity ? ` (revised: ${r.revisedSeverity})` : ""}: ${r.note || "(no note)"}`);
    const counter = counters.get(r.id);
    if (counter) {
      lines.push(`  - counter by ${counter.agent}: ${counter.upheld ? "upholds critique" : "withdraws critique"} - ${counter.note || "(no note)"}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}
