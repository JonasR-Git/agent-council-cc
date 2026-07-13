/**
 * Parse / normalize / merge structured council findings.
 */

import { getLens } from "./audit-lenses.mjs";
import { SCHEMAS } from "./schemas.mjs";
import { validate } from "./validate.mjs";
import { firstLines, isObject } from "./util.mjs";

export const SEVERITY_RANK = { P0: 0, P1: 1, P2: 2, nit: 3 };

function parseJsonValue(text) {
  try {
    const parsed = JSON.parse(text);
    // Objects AND top-level arrays are legitimate candidates: a model asked for a
    // findings report routinely answers with the bare findings LIST.
    return isObject(parsed) || Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Yield EVERY parseable JSON value in `text` (fenced blocks first, then the whole text,
 * then a brace/bracket scan) so a caller can take the first candidate that matches ITS
 * shape. Committing to the first *parseable* candidate let a chatty preamble object
 * ({"status":"analyzing"}) or a stray array shadow the real document - which silently
 * zeroes out a whole seat's review.
 */
export function* extractJsonCandidates(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return;

  const fenceRe = /```(?:json)?\s*([\s\S]*?)```/gi;
  for (const match of raw.matchAll(fenceRe)) {
    const parsed = parseJsonValue(match[1].trim());
    if (parsed) yield parsed;
  }

  const whole = parseJsonValue(raw);
  if (whole) yield whole;

  const CLOSER = { "{": "}", "[": "]" };
  for (let start = 0; start < raw.length; start += 1) {
    const open = raw[start];
    const close = CLOSER[open];
    if (!close) continue;
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
      } else if (ch === open) {
        depth += 1;
      } else if (ch === close) {
        depth -= 1;
        if (depth === 0) {
          const parsed = parseJsonValue(raw.slice(start, i + 1));
          if (parsed) yield parsed;
          break;
        }
      }
    }
  }
}

/** First parseable JSON OBJECT (unchanged contract for the non-findings callers). */
export function extractJsonObject(text) {
  for (const candidate of extractJsonCandidates(text)) {
    if (isObject(candidate)) return candidate;
  }
  return null;
}

/**
 * Coerce a model-supplied number. `null` / absent / non-numeric stays NULL - never 0:
 * Number(null) === 0 is finite, so the old guard turned every `"line": null` (which is
 * exactly what the prompt templates ask for on a whole-file finding) into "line 0".
 */
function toFiniteNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** A usable 1-based line, or null. 0/negative means "no line", not line zero. */
function toLine(value) {
  const n = toFiniteNumber(value);
  return n != null && n >= 1 ? n : null;
}

const DEFAULT_CONFIDENCE = 0.6;

/**
 * Severity synonyms -> the P-scale. A user-configured seat (any OpenRouter model, or any
 * model that ignores the P-scale) emits "critical"/"high"/"minor"/...; mapping all of them
 * to P2 silently DEMOTED its P0 below the P0/P1 refutation gate and below §6 attention,
 * with no unparsed signal at all. Tokens are compared lowercased and stripped of
 * separators, so "SEV-0" / "sev 0" / "p0" all land on P0.
 */
const SEVERITY_ALIASES = new Map(
  Object.entries({
    p0: "P0", sev0: "P0", s0: "P0", critical: "P0", crit: "P0", blocker: "P0", blocking: "P0", fatal: "P0",
    p1: "P1", sev1: "P1", s1: "P1", high: "P1", major: "P1", severe: "P1",
    p2: "P2", sev2: "P2", s2: "P2", medium: "P2", moderate: "P2", normal: "P2", warning: "P2",
    nit: "nit", nits: "nit", nitpick: "nit", sev3: "nit", s3: "nit",
    low: "nit", minor: "nit", info: "nit", informational: "nit", trivial: "nit", style: "nit", cosmetic: "nit"
  })
);

/**
 * -> { severity, raw, unrecognized }. `raw` is set whenever the model's token was not
 * already canonical (so a report can show what it actually said); `unrecognized` marks a
 * token we could NOT map - it still falls back to P2, but never silently.
 */
function resolveSeverity(value) {
  const raw = value == null ? "" : String(value).trim();
  const token = raw.toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (!token) return { severity: "P2", raw: null, unrecognized: false };
  const mapped = SEVERITY_ALIASES.get(token);
  if (mapped) return { severity: mapped, raw: mapped === raw ? null : raw, unrecognized: false };
  return { severity: "P2", raw, unrecognized: true };
}

function normalizeFindingsDoc(doc, agentFallback = "unknown") {
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
  // Trust the RUNNER's identity (agentFallback), never the model-provided
  // doc.agent: an injected diff could make a spawned reviewer emit
  // {"agent":"codex"} to spoof a peer, and a stray "Claude"/"claude-opus"
  // would drop it from agent===... lookups (R2/consensus). Only honor
  // doc.agent when the caller genuinely doesn't know who ran ("unknown").
  const agent = agentFallback !== "unknown" ? agentFallback : String(doc.agent ?? "unknown");
  const normalized = findings.map((f, i) => {
    const sev = resolveSeverity(f?.severity);
    return {
      id: String(f?.id ?? `${agentFallback}-${i + 1}`),
      severity: sev.severity,
      // Only present when the model's token was NOT canonical - a genuinely unknown token
      // keeps the P2 fallback but is surfaced (never a silent demotion).
      ...(sev.raw != null ? { severityRaw: sev.raw } : {}),
      ...(sev.unrecognized ? { severityUnrecognized: true } : {}),
      category: String(f?.category ?? "other"),
      title: String(f?.title ?? f?.summary ?? "Untitled").trim(),
      detail: String(f?.detail ?? f?.description ?? "").trim(),
      file: f?.file != null ? String(f.file) : null,
      // A whole-file finding ("line": null, what every prompt template asks for) stays
      // UNLOCATED. Coercing it to 0 made two such findings look 0 lines apart, and the
      // merge then fabricated cross-seat consensus off a single shared title token.
      line: toLine(f?.line),
      // "confidence": null means "unstated", exactly like an absent field - not "zero
      // confidence" (which Number(null)===0 used to assert on the model's behalf).
      confidence: toFiniteNumber(f?.confidence) ?? DEFAULT_CONFIDENCE,
      // Preserve a VALID model-supplied lens (a registered lens id) so a multi-lens group pass keeps
      // each finding's real class — without it the lens is dropped and a security_secrets P0 surfaced
      // under a multi-lens group would lose the tag the P0 live-hole override keys on (council B5
      // codex P2). An unknown/absent lens stays undefined for downstream categoryToLens to fill.
      lens: f?.lens && getLens(f.lens) ? String(f.lens) : undefined,
      agent,
      // Honor an explicit agent scope override ("localized"/"cross-cutting");
      // anything else stays undefined so annotateScopes falls back to heuristics.
      scope: f?.scope === "localized" || f?.scope === "cross-cutting" ? f.scope : undefined
    };
  });

  const unrecognizedSeverities = normalized
    .filter((f) => f.severityUnrecognized)
    .map((f) => ({ id: f.id, severity: f.severityRaw }));
  const VALID_VERDICTS = new Set(["approve", "approve_with_nits", "request_changes", "block"]);
  const verdict = String(doc.verdict ?? "").toLowerCase().trim();
  return {
    agent,
    summary: String(doc.summary ?? "").trim(),
    verdict: VALID_VERDICTS.has(verdict) ? verdict : "request_changes",
    findings: normalized,
    // Absent when every token parsed - a canonical doc stays byte-identical.
    ...(unrecognizedSeverities.length ? { unrecognizedSeverities } : {}),
    parseOk: true
  };
}

/**
 * A findings DOCUMENT, or null. A bare top-level array is a doc too: models answer the
 * "emit the findings" prompt with the list itself often enough that dropping it loses a
 * whole seat's review.
 */
function asFindingsDoc(candidate) {
  if (Array.isArray(candidate)) return { findings: candidate };
  if (isObject(candidate) && Array.isArray(candidate.findings)) return candidate;
  return null;
}

export function parseAgentFindings(stdout, agent) {
  const raw = String(stdout ?? "");
  // Take the first candidate that VALIDATES as a findings doc - not merely the first
  // parseable JSON. A preamble object or an unrelated array earlier in the reply would
  // otherwise shadow the real document and silently drop the seat to zero findings.
  let shapedErrors = null;
  let anyErrors = null;
  for (const candidate of extractJsonCandidates(stdout)) {
    const doc = asFindingsDoc(candidate);
    if (!doc) {
      anyErrors ??= validate(SCHEMAS.findings, candidate).errors;
      continue;
    }
    const checked = validate(SCHEMAS.findings, doc);
    if (checked.valid) return { ...normalizeFindingsDoc(doc, agent), raw };
    shapedErrors ??= checked.errors;
  }
  return {
    agent,
    summary: firstLines(stdout, 8),
    verdict: "request_changes",
    findings: [],
    parseOk: false,
    validationErrors: shapedErrors ?? anyErrors ?? ["$: no JSON object found"],
    raw
  };
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
  // missed is optional bonus content and re-validated downstream as its own
  // findings doc - a bad missed item must never reject the votes.
  if (Array.isArray(shell.missed)) shell.missed = [];
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

/** A real 1-based location, or null for "unlocated" (whole-file finding, 0, garbage). */
function knownLine(f) {
  const n = Number(f?.line);
  return f?.line != null && Number.isFinite(n) && n >= 1 ? n : null;
}

function lineClose(a, b) {
  const left = knownLine(a);
  const right = knownLine(b);
  // An UNKNOWN line is not a location. Two whole-file findings are not "0 lines apart",
  // they are simply unlocated - reading them as co-located (the old Number(null)===0
  // path) let one shared 3-char title token fuse two unrelated findings from different
  // seats into a FABRICATED consensus, which then also skipped refutation.
  if (left == null || right == null) return false;
  return Math.abs(left - right) <= 10;
}

function fuzzyMatch(a, b) {
  const file = normalizedFile(a.file);
  if (!file || file !== normalizedFile(b.file)) {
    return false;
  }
  // Line proximity alone must never merge: two unrelated findings a few lines
  // apart would fabricate consensus. Nearby lines only count with at least one
  // shared title token; otherwise require strong title similarity. With an unknown
  // line on either side there is no proximity signal at all, so strong title
  // similarity is the ONLY way in.
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
  if (!target.scope && source.scope) target.scope = source.scope;
  if (SEVERITY_RANK[source.severity] < SEVERITY_RANK[target.severity]) {
    target.severity = source.severity;
    target.category = source.category;
    target.title = source.title;
    target.detail = source.detail;
    // Prefer the higher-severity description, but never discard a known
    // location: only adopt source's line/file when it actually has one.
    if (source.line != null) target.line = source.line;
    if (source.file) target.file = source.file;
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
          scope: f.scope,
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
          scope: f.scope,
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
      // A vote that carries a targetId is a precise reference: it matches ONLY the
      // finding whose id it names. Falling through to the title match would let an
      // agree vote for finding X fabricate consensus on a DIFFERENT finding Y that
      // merely shares X's normalized title (e.g. the same issue in another file).
      // The title fallback exists solely for votes with no targetId at all.
      if (v.targetId) return item.ids.includes(v.targetId);
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

  if (merged.refuted?.length) {
    lines.push("### Refuted / low-confidence (survived neither verification)");
    lines.push("These P0/P1 findings were refuted in the adversarial verification pass — treat as low-confidence.");
    for (const f of merged.refuted) {
      lines.push(formatMergedItem(f));
      if (f.verified?.reason) lines.push(`  _refuted by ${f.verified.by}: ${f.verified.reason}_`);
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
  const ledger =
    f.seenBefore && f.timesSeen > 1
      ? `seen ${f.timesSeen}x${f.ledgerStatus && f.ledgerStatus !== "open" && f.ledgerStatus !== "new" ? ` · was ${f.ledgerStatus}` : ""}`
      : null;
  const scope = f.scope === "cross-cutting" ? "cross-cutting→document" : f.scope === "localized" ? "localized→fixable" : null;
  const verified = f.verified
    ? f.verified.refuted
      ? `disputed by ${f.verified.by}`
      : "verified"
    : null;
  const flags = [
    f.contested ? "contested" : null,
    f.fromPeerMissed ? "peer-missed" : null,
    verified,
    scope,
    ledger,
    voters
  ]
    .filter(Boolean)
    .join(" · ");
  return [
    `- **${f.severity}** [${f.agents.join("+")}] ${f.title} - ${loc}${peers}${flags ? ` · ${flags}` : ""}`,
    `  ${f.detail}`
  ].join("\n");
}
