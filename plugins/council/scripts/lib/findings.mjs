/**
 * Parse / normalize / merge structured council findings.
 */

const SEVERITY_RANK = { P0: 0, P1: 1, P2: 2, nit: 3 };

export function extractJsonObject(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return null;

  // Fenced ```json ... ```
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    try {
      return JSON.parse(fence[1].trim());
    } catch {
      /* continue */
    }
  }

  // Whole string
  try {
    return JSON.parse(raw);
  } catch {
    /* continue */
  }

  // First { ... last }
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch {
      return null;
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
  if (!doc || typeof doc !== "object") {
    return {
      agent: agentFallback,
      summary: "",
      verdict: "request_changes",
      findings: [],
      parseOk: false
    };
  }

  const findings = Array.isArray(doc.findings) ? doc.findings : [];
  const normalized = findings.map((f, i) => ({
    id: String(f?.id ?? `${agentFallback}-${i + 1}`),
    severity: normalizeSeverity(f?.severity),
    category: String(f?.category ?? "other"),
    title: String(f?.title ?? f?.summary ?? "Untitled").trim(),
    detail: String(f?.detail ?? f?.description ?? "").trim(),
    file: f?.file != null ? String(f.file) : null,
    line: Number.isFinite(Number(f?.line)) ? Number(f.line) : null,
    confidence: Number.isFinite(Number(f?.confidence)) ? Number(f.confidence) : 0.6,
    agent: agentFallback
  }));

  return {
    agent: String(doc.agent ?? agentFallback),
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
      raw: String(stdout ?? "")
    };
  }
  return { ...normalizeFindingsDoc(parsed, agent), raw: String(stdout ?? "") };
}

function firstLines(text, n) {
  return String(text ?? "")
    .split(/\r?\n/)
    .slice(0, n)
    .join("\n")
    .trim();
}

function findingKey(f) {
  const file = (f.file ?? "").toLowerCase().replace(/\\/g, "/");
  const title = (f.title ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  // soft key for consensus: file + first 48 of title
  return `${file}::${title.slice(0, 48)}`;
}

/**
 * Merge independent reviews into consensus / contested / unique buckets.
 */
export function mergeFindings(docs) {
  const buckets = new Map();

  for (const doc of docs) {
    if (!doc?.findings?.length) continue;
    for (const f of doc.findings) {
      const key = findingKey(f);
      if (!buckets.has(key)) {
        buckets.set(key, {
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
        const b = buckets.get(key);
        if (!b.agents.includes(doc.agent)) b.agents.push(doc.agent);
        b.ids.push(f.id);
        b.confidences.push(f.confidence);
        // escalate severity to worst
        if (SEVERITY_RANK[f.severity] < SEVERITY_RANK[b.severity]) {
          b.severity = f.severity;
          b.detail = f.detail;
        }
      }
    }
  }

  const merged = [...buckets.values()].map((b) => ({
    ...b,
    agreement: b.agents.length,
    consensus: b.agents.length >= 2,
    avgConfidence:
      b.confidences.reduce((a, c) => a + c, 0) / Math.max(1, b.confidences.length)
  }));

  merged.sort((a, b) => {
    if (a.consensus !== b.consensus) return a.consensus ? -1 : 1;
    if (SEVERITY_RANK[a.severity] !== SEVERITY_RANK[b.severity]) {
      return SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    }
    return b.agreement - a.agreement;
  });

  return {
    consensus: merged.filter((m) => m.consensus),
    unique: merged.filter((m) => !m.consensus),
    all: merged
  };
}

/**
 * Apply peer critique votes onto merged findings when possible.
 * critiqueDoc: { votes: [{ targetId or title, vote: agree|disagree|uncertain, note }] }
 */
export function applyPeerVotes(merged, critiques) {
  const votes = [];
  for (const c of critiques) {
    const doc = extractJsonObject(c.stdout) ?? c.parsed;
    if (!doc) continue;
    const list = Array.isArray(doc.votes) ? doc.votes : Array.isArray(doc.findings) ? [] : [];
    // also accept { critiques: [...] }
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
      if (v.title && item.title && v.title.toLowerCase() === item.title.toLowerCase()) return true;
      return false;
    });
    return { ...item, peerVotes: related };
  });

  return { ...merged, all: enriched, votes };
}

export function renderMergedMarkdown(merged, options = {}) {
  const lines = [];
  lines.push("## Merged findings");
  lines.push("");
  lines.push(`Consensus (≥2 agents): **${merged.consensus.length}** · Unique: **${merged.unique.length}**`);
  lines.push("");

  if (merged.consensus.length) {
    lines.push("### Consensus");
    for (const f of merged.consensus) {
      lines.push(formatMergedItem(f));
    }
    lines.push("");
  }

  if (merged.unique.length) {
    lines.push("### Unique (single agent — verify before acting)");
    for (const f of merged.unique) {
      lines.push(formatMergedItem(f));
    }
    lines.push("");
  }

  if (options.includeVotes && merged.votes?.length) {
    lines.push("### Peer votes (round 2)");
    for (const v of merged.votes) {
      lines.push(
        `- **${v.from}→${v.about}** ${v.vote}: ${v.title || v.targetId || "?"} — ${v.note || ""}`
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}

function formatMergedItem(f) {
  const loc = f.file ? `\`${f.file}${f.line != null ? `:${f.line}` : ""}\`` : "_no file_";
  const peers = f.peerVotes?.length
    ? ` · peers: ${f.peerVotes.map((v) => `${v.from}:${v.vote}`).join(", ")}`
    : "";
  return [
    `- **${f.severity}** [${f.agents.join("+")}] ${f.title} — ${loc}${peers}`,
    `  ${f.detail}`
  ].join("\n");
}
