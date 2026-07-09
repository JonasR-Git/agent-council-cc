/**
 * Parse / normalize / merge structured council findings.
 */

import { SCHEMAS } from "./schemas.mjs";
import { validate } from "./validate.mjs";

const SEVERITY_RANK = { P0: 0, P1: 1, P2: 2, nit: 3 };

function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function parseJsonObject(text) {
  try {
    const parsed = JSON.parse(text);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function extractJsonObject(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return null;

  const fenceRe = /```(?:json)?\s*([\s\S]*?)```/gi;
  for (const match of raw.matchAll(fenceRe)) {
    const parsed = parseJsonObject(match[1].trim());
    if (parsed) return parsed;
  }

  const whole = parseJsonObject(raw);
  if (whole) return whole;

  for (let start = 0; start < raw.length; start += 1) {
    if (raw[start] !== "{") continue;
    let depth = 0;
    let inString = false;
    let escape = false;

    for (let i = start; i < raw.length; i += 1) {
      const ch = raw[i];
      if (inString) {
        if (escape) {
          escape = false;
        } else if (ch === "\\") {
          escape = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }

      if (ch === '"') {
        inString = true;
      } else if (ch === "{") {
        depth += 1;
      } else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          const parsed = parseJsonObject(raw.slice(start, i + 1));
          if (parsed) return parsed;
          break;
        }
      }
    }
  }

  return null;
}

function normalizeSeverity(value) {
  const s = String(value ?? "P2").toUpperCase();
  if (s === "P0" || s === "P1" || s === "P2") return s;
  if (s === "NIT" || s === "NITS") return "nit";
  return "P2";
}

export function normalizeFindingsDoc(doc, agentFallback = "unknown") {
  const validShape = isObject(doc) && (Array.isArray(doc.findings) || Array.isArray(doc.votes));
  if (!validShape) {
    return {
      agent: agentFallback,
      summary: isObject(doc) ? String(doc.summary ?? "").trim() : "",
      verdict: "request_changes",
      findings: [],
      parseOk: false
    };
  }

  const findings = Array.isArray(doc.findings) ? doc.findings : [];
  const agent = String(doc.agent ?? agentFallback);
  const normalized = findings.map((f, i) => ({
    id: String(f?.id ?? `${agentFallback}-${i + 1}`),
    severity: normalizeSeverity(f?.severity),
    category: String(f?.category ?? "other"),
    title: String(f?.title ?? f?.summary ?? "Untitled").trim(),
    detail: String(f?.detail ?? f?.description ?? "").trim(),
    file: f?.file != null ? String(f.file) : null,
    line: Number.isFinite(Number(f?.line)) ? Number(f.line) : null,
    confidence: Number.isFinite(Number(f?.confidence)) ? Number(f.confidence) : 0.6,
    agent
  }));

  return {
    agent,
    summary: String(doc.summary ?? "").trim(),
    verdict: String(doc.verdict ?? "request_changes"),
    findings: normalized,
    parseOk: true
  };
}

export function parseAgentFindings(stdout, agent) {
  const parsed = extractJsonObject(stdout);
  if (!parsed) {
    return {
      agent,
      summary: firstLines(stdout, 8),
      verdict: "request_changes",
      findings: [],
      parseOk: false,
      validationErrors: ["$: no JSON object found"],
      raw: String(stdout ?? "")
    };
  }
  const checked = validate(SCHEMAS.findings, parsed);
  if (!checked.valid) {
    return {
      agent,
      summary: firstLines(stdout, 8),
      verdict: "request_changes",
      findings: [],
      parseOk: false,
      validationErrors: checked.errors,
      raw: String(stdout ?? "")
    };
  }
  return { ...normalizeFindingsDoc(parsed, agent), raw: String(stdout ?? "") };
}

export function parseCritiqueVotes(stdout, agent, aboutAgent) {
  const doc = extractJsonObject(stdout);
  const raw = String(stdout ?? "");
  if (!isObject(doc)) {
    return {
      agent,
      aboutAgent,
      summary: firstLines(stdout, 4),
      votes: [],
      missed: [],
      parseOk: false,
      validationErrors: ["$: no JSON object found"],
      raw
    };
  }

  const shell = { ...doc };
  if (Array.isArray(shell.votes)) shell.votes = [];
  const documentCheck = validate(SCHEMAS.critiqueVotes, shell);
  if (!documentCheck.valid) {
    return {
      agent,
      aboutAgent,
      summary: String(doc.summary ?? "").trim(),
      votes: [],
      missed: [],
      parseOk: false,
      validationErrors: documentCheck.errors,
      raw
    };
  }

  const votes = [];
  const validationErrors = [];
  for (const [index, vote] of doc.votes.entries()) {
    const checked = validate(SCHEMAS.critiqueVotes.properties.votes.items, vote);
    if (checked.valid) votes.push(vote);
    else {
      validationErrors.push(
        ...checked.errors.map((error) => error.replace(/^\$/, `$.votes[${index}]`))
      );
    }
  }
  return {
    agent: String(doc.agent ?? agent),
    aboutAgent: String(doc.about ?? aboutAgent),
    about: String(doc.about ?? aboutAgent),
    summary: String(doc.summary ?? "").trim(),
    votes,
    missed: Array.isArray(doc.missed) ? doc.missed : [],
    parseOk: true,
    validationErrors,
    raw
  };
}

function firstLines(text, n) {
  return String(text ?? "")
    .split(/\r?\n/)
    .slice(0, n)
    .join("\n")
    .trim();
}

function normalizedFile(file) {
  return String(file ?? "").toLowerCase().replace(/\\/g, "/").trim();
}

function normalizedTitle(title) {
  return String(title ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

function findingKey(f) {
  return `${normalizedFile(f.file)}::${normalizedTitle(f.title).slice(0, 48)}`;
}

function wordTokens(text) {
  return new Set(
    String(text ?? "")
      .toLowerCase()
      .match(/[a-z0-9_]+/g)
      ?.filter((token) => token.length >= 3) ?? []
  );
}

export function titleSimilarity(a, b) {
  const left = wordTokens(a);
  const right = wordTokens(b);
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection += 1;
  }
  const union = new Set([...left, ...right]).size;
  return intersection / union;
}

function lineClose(a, b) {
  return a.line != null && b.line != null && Math.abs(Number(a.line) - Number(b.line)) <= 10;
}

function fuzzyMatch(a, b) {
  const file = normalizedFile(a.file);
  if (!file || file !== normalizedFile(b.file)) {
    return false;
  }
  // Line proximity alone must never merge: two unrelated findings a few lines
  // apart would fabricate consensus. Nearby lines only count with at least one
  // shared title token; otherwise require strong title similarity.
  const similarity = titleSimilarity(a.title, b.title);
  return (lineClose(a, b) && similarity > 0) || similarity >= 0.4;
}

function shouldMergeBuckets(a, b) {
  const disjointAgents = !a.agents.some((agent) => b.agents.includes(agent));
  return disjointAgents && fuzzyMatch(a, b);
}

function mergeBucketInto(target, source) {
  for (const agent of source.agents) {
    if (!target.agents.includes(agent)) target.agents.push(agent);
  }
  target.ids.push(...source.ids);
  target.confidences.push(...source.confidences);
  if (target.line == null && source.line != null) target.line = source.line;
  if (!target.file && source.file) target.file = source.file;
  if (SEVERITY_RANK[source.severity] < SEVERITY_RANK[target.severity]) {
    target.severity = source.severity;
    target.category = source.category;
    target.title = source.title;
    target.detail = source.detail;
    target.line = source.line;
  }
  return target;
}

function sortMergedItems(items) {
  return [...items].sort((a, b) => {
    if (a.consensus !== b.consensus) return a.consensus ? -1 : 1;
    if (SEVERITY_RANK[a.severity] !== SEVERITY_RANK[b.severity]) {
      return SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    }
    if (b.agreement !== a.agreement) return b.agreement - a.agreement;
    return String(a.key).localeCompare(String(b.key));
  });
}

function finalizeBuckets(buckets) {
  const items = buckets.map((b) => ({
    ...b,
    voteAgents: b.voteAgents ?? [],
    agreement: b.agents.length + (b.voteAgents?.length ?? 0),
    consensus: b.agents.length + (b.voteAgents?.length ?? 0) >= 2,
    avgConfidence: b.confidences.reduce((a, c) => a + c, 0) / Math.max(1, b.confidences.length)
  }));
  const sorted = sortMergedItems(items);
  return {
    consensus: sorted.filter((m) => m.consensus),
    unique: sorted.filter((m) => !m.consensus),
    all: sorted
  };
}

/**
 * Merge independent reviews into consensus / contested / unique buckets.
 */
export function mergeFindings(docs) {
  const exactBuckets = new Map();

  for (const doc of docs) {
    if (!doc?.findings?.length) continue;
    for (const f of doc.findings) {
      const key = findingKey(f);
      if (!exactBuckets.has(key)) {
        exactBuckets.set(key, {
          key,
          title: f.title,
          file: f.file,
          line: f.line,
          severity: f.severity,
          category: f.category,
          detail: f.detail,
          agents: [doc.agent],
          ids: [f.id],
          confidences: [f.confidence]
        });
      } else {
        mergeBucketInto(exactBuckets.get(key), {
          key,
          title: f.title,
          file: f.file,
          line: f.line,
          severity: f.severity,
          category: f.category,
          detail: f.detail,
          agents: [doc.agent],
          ids: [f.id],
          confidences: [f.confidence]
        });
      }
    }
  }

  const buckets = [...exactBuckets.values()].sort((a, b) => a.key.localeCompare(b.key));
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < buckets.length; i += 1) {
      for (let j = i + 1; j < buckets.length; j += 1) {
        if (shouldMergeBuckets(buckets[i], buckets[j])) {
          mergeBucketInto(buckets[i], buckets[j]);
          buckets.splice(j, 1);
          changed = true;
          break;
        }
      }
      if (changed) break;
    }
  }

  return finalizeBuckets(buckets);
}

function rebuildMerged(merged, all) {
  const sorted = sortMergedItems(all);
  return {
    ...merged,
    all: sorted,
    consensus: sorted.filter((item) => item.consensus),
    unique: sorted.filter((item) => !item.consensus)
  };
}

/**
 * Apply peer critique votes onto merged findings when possible.
 * critiqueDoc: { votes: [{ targetId or title, vote: agree|disagree|uncertain, note }] }
 */
export function applyPeerVotes(merged, critiques) {
  const votes = [];
  for (const c of critiques) {
    const doc = c.parsed ?? extractJsonObject(c.stdout);
    if (!doc || doc.parseOk === false) continue;
    const list = Array.isArray(doc.votes) ? doc.votes : Array.isArray(doc.findings) ? [] : [];
    const rawVotes = list.length
      ? list
      : Array.isArray(doc.critiques)
        ? doc.critiques
        : Array.isArray(doc.evaluations)
          ? doc.evaluations
          : [];

    for (const v of rawVotes) {
      votes.push({
        from: c.agent,
        about: c.aboutAgent,
        targetId: v.targetId ?? v.id ?? null,
        title: v.title ?? null,
        vote: String(v.vote ?? v.verdict ?? "uncertain").toLowerCase(),
        note: String(v.note ?? v.detail ?? "").trim()
      });
    }
  }

  const enriched = merged.all.map((item) => {
    const related = votes.filter((v) => {
      if (v.targetId && item.ids.includes(v.targetId)) return true;
      if (v.title && item.title && normalizedTitle(v.title) === normalizedTitle(item.title)) return true;
      return false;
    });
    const voteAgents = [...(item.voteAgents ?? [])];
    for (const vote of related) {
      if (vote.vote === "agree" && !item.agents.includes(vote.from) && !voteAgents.includes(vote.from)) {
        voteAgents.push(vote.from);
      }
    }
    const agreement = item.agents.length + voteAgents.length;
    return {
      ...item,
      voteAgents,
      peerVotes: related,
      agreement,
      consensus: agreement >= 2,
      contested: related.length > 0 && related.every((v) => v.vote === "disagree")
    };
  });

  return rebuildMerged({ ...merged, votes }, enriched);
}

function matchesExisting(existing, finding) {
  if (findingKey(existing) === findingKey(finding)) {
    return true;
  }
  return fuzzyMatch(existing, finding);
}

export function dedupeAgainst(merged, missedDocs) {
  const existing = merged.all ?? [];
  return missedDocs
    .map((doc) => ({
      ...doc,
      findings: (doc.findings ?? []).filter((finding) => !existing.some((item) => matchesExisting(item, finding)))
    }))
    .filter((doc) => doc.findings.length > 0);
}

export function applyConsensusPolicy(merged, categories = []) {
  const required = new Set(categories.map((c) => String(c).toLowerCase()));
  if (!required.size) {
    return merged;
  }
  const all = merged.all.map((item) => ({
    ...item,
    needsConsensus: !item.consensus && required.has(String(item.category ?? "").toLowerCase())
  }));
  return rebuildMerged(merged, all);
}

export function slimFindingsDoc(doc) {
  return {
    agent: doc?.agent,
    summary: doc?.summary,
    verdict: doc?.verdict,
    findings: doc?.findings ?? []
  };
}

export function renderMergedMarkdown(merged, options = {}) {
  const lines = [];
  lines.push("## Merged findings");
  lines.push("");
  lines.push(`Consensus (>=2 agents): **${merged.consensus.length}** · Unique: **${merged.unique.length}**`);
  lines.push("");

  if (merged.consensus.length) {
    lines.push("### Consensus");
    for (const f of merged.consensus) {
      lines.push(formatMergedItem(f));
    }
    lines.push("");
  }

  const policyUnique = merged.unique.filter((f) => f.needsConsensus);
  const regularUnique = merged.unique.filter((f) => !f.needsConsensus);

  if (policyUnique.length) {
    lines.push("### Unique - policy: requires >=2-agent consensus (verify before acting)");
    lines.push("Warning: project policy requires another reviewer or human verification before acting on these categories.");
    for (const f of policyUnique) {
      lines.push(formatMergedItem(f));
    }
    lines.push("");
  }

  if (regularUnique.length) {
    lines.push("### Unique (single agent - verify before acting)");
    for (const f of regularUnique) {
      lines.push(formatMergedItem(f));
    }
    lines.push("");
  }

  if (options.includeVotes && merged.votes?.length) {
    lines.push("### Peer votes (round 2)");
    for (const v of merged.votes) {
      lines.push(
        `- **${v.from}->${v.about}** ${v.vote}: ${v.title || v.targetId || "?"} - ${v.note || ""}`
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}

function formatMergedItem(f) {
  const loc = f.file ? `\`${f.file}${f.line != null ? `:${f.line}` : ""}\`` : "_no file_";
  const voters = f.voteAgents?.length ? `+votes:${f.voteAgents.join("+")}` : "";
  const peers = f.peerVotes?.length
    ? ` · peers: ${f.peerVotes.map((v) => `${v.from}:${v.vote}`).join(", ")}`
    : "";
  const flags = [f.contested ? "contested" : null, f.fromPeerMissed ? "peer-missed" : null, voters]
    .filter(Boolean)
    .join(" · ");
  return [
    `- **${f.severity}** [${f.agents.join("+")}] ${f.title} - ${loc}${peers}${flags ? ` · ${flags}` : ""}`,
    `  ${f.detail}`
  ].join("\n");
}
