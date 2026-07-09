import fs from "node:fs";
import path from "node:path";

import {
  READONLY_DISALLOWED_TOOLS,
  interpolate,
  loadPrompt,
  runCodexStructured,
  runGrokStructured,
  waitForFile
} from "./agents.mjs";
import { applyDebateOutcomes, renderDebateSection, runDebateRounds } from "./debate.mjs";
import {
  applyConsensusPolicy,
  applyPeerVotes,
  dedupeAgainst,
  extractJsonObject,
  mergeFindings,
  parseAgentFindings,
  renderMergedMarkdown,
  slimFindingsDoc
} from "./findings.mjs";
import { collectReviewContext, resolveReviewTarget } from "./git-context.mjs";
import { wrapMarkdownFence } from "./markdown-fence.mjs";

export { READONLY_DISALLOWED_TOOLS, runCodexStructured, runGrokStructured };

const EVIDENCE_LINES = 25;
const EVIDENCE_PER_FINDING_CHARS = 1500;
const EVIDENCE_TOTAL_CHARS = 16_000;
const EVIDENCE_FALLBACK_CHARS = 8000;

/**
 * Keep only findings whose severity warrants a peer critique round.
 * An empty/missing severity list means "critique everything".
 */
export function filterDocForCritique(doc, severities) {
  const total = doc?.findings?.length ?? 0;
  const allowed = new Set(severities ?? []);
  if (!allowed.size) {
    return { doc, critiqued: total, total };
  }
  const findings = (doc?.findings ?? []).filter((f) => allowed.has(f.severity));
  return {
    doc: { ...doc, findings },
    critiqued: findings.length,
    total
  };
}

/**
 * Per-finding code evidence (±N lines around each finding) instead of a bulk
 * diff excerpt — the critic can open files with its own tools if it needs more.
 */
export function buildEvidence(repoRoot, findings, fallbackContent = "") {
  const sections = [];
  let totalChars = 0;
  const rootResolved = path.resolve(repoRoot);
  for (const f of findings ?? []) {
    if (!f?.file) continue;
    // Findings come from model output — confine evidence reads to the repo.
    const resolved = path.resolve(rootResolved, String(f.file));
    const insideRepo =
      process.platform === "win32"
        ? resolved.toLowerCase() === rootResolved.toLowerCase() ||
          resolved.toLowerCase().startsWith(`${rootResolved.toLowerCase()}${path.sep}`)
        : resolved === rootResolved || resolved.startsWith(`${rootResolved}${path.sep}`);
    if (!insideRepo) continue;
    let text;
    try {
      text = fs.readFileSync(resolved, "utf8");
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    const line = f.line != null && Number.isFinite(Number(f.line)) ? Number(f.line) : 1;
    const start = Math.max(1, line - EVIDENCE_LINES);
    const end = Math.min(lines.length, line + EVIDENCE_LINES);
    let snippet = lines
      .slice(start - 1, end)
      .map((content, idx) => `${start + idx}: ${content}`)
      .join("\n");
    if (snippet.length > EVIDENCE_PER_FINDING_CHARS) {
      snippet = `${snippet.slice(0, EVIDENCE_PER_FINDING_CHARS)}\n[... truncated ...]`;
    }
    const section = `### ${f.id ?? "finding"} — ${f.file}:${f.line ?? "?"}\n${wrapMarkdownFence(snippet)}`;
    if (totalChars + section.length > EVIDENCE_TOTAL_CHARS) break;
    totalChars += section.length;
    sections.push(section);
  }
  if (!sections.length) {
    const fallback = String(fallbackContent ?? "").slice(0, EVIDENCE_FALLBACK_CHARS);
    return fallback || "(no file evidence available)";
  }
  return sections.join("\n\n");
}

function buildR1Prompt(agent, context, options) {
  const template = loadPrompt("r1-independent");
  return interpolate(template, {
    AGENT: agent,
    TARGET_LABEL: context.target.label,
    BRANCH: context.branch,
    HEAD: context.head,
    SNAPSHOT_ID: context.snapshotId,
    USER_FOCUS: options.focusText || "None",
    POLICY_FOCUS: options.policyFocus || options.focusText || "None",
    REVIEW_INPUT: context.content
  });
}

function buildR2Prompt(agent, aboutAgent, aboutFindings, context) {
  const template = loadPrompt("r2-peer-critique");
  return interpolate(template, {
    AGENT: agent,
    ABOUT_AGENT: aboutAgent,
    OTHER_FINDINGS_JSON: JSON.stringify(slimFindingsDoc(aboutFindings), null, 2),
    EVIDENCE: buildEvidence(context.repoRoot, aboutFindings.findings, context.content)
  });
}

async function loadClaudeDoc(options) {
  if (options.claudeFindingsPath && fs.existsSync(options.claudeFindingsPath)) {
    const text = fs.readFileSync(options.claudeFindingsPath, "utf8");
    return parseAgentFindings(text, "claude");
  }

  if (options.claudeFindingsWaitPath) {
    const waitTimeoutMs = Number(options.waitTimeoutMs ?? 300_000);
    const found = fs.existsSync(options.claudeFindingsWaitPath)
      ? options.claudeFindingsWaitPath
      : await waitForFile(options.claudeFindingsWaitPath, waitTimeoutMs);
    if (found) {
      const text = fs.readFileSync(found, "utf8");
      return parseAgentFindings(text, "claude");
    }
  }

  return null;
}

function r2Options(options) {
  return {
    ...options,
    maxTurns: options.maxTurnsR2,
    grokEffort: options.r2Effort ?? options.grokEffort
  };
}

function buildDebateEntries(merged, options) {
  const skipped = new Set(
    [options.skipCodex ? "codex" : null, options.skipGrok ? "grok" : null].filter(Boolean)
  );
  return merged.all
    .filter((item) => item.contested)
    .map((item) => {
      const author = item.agents.find((agent) => agent !== "claude" && !skipped.has(agent));
      if (!author) return null;
      const disagree = (item.peerVotes ?? []).filter((v) => v.vote === "disagree");
      const critic = disagree
        .map((v) => v.from)
        .find((from) => from !== author && from !== "claude" && !skipped.has(from));
      return {
        id: item.ids[0],
        author,
        critic: critic ?? null,
        payload: {
          title: item.title,
          severity: item.severity,
          category: item.category,
          file: item.file,
          line: item.line,
          detail: item.detail,
          critiques: disagree.map((v) => ({ from: v.from, note: v.note }))
        }
      };
    })
    .filter(Boolean);
}

/**
 * Full deliberation: R1 independent (codex+grok [+claude file]) then R2 cross-critique.
 */
export async function runDeliberation(cwd, backends, options = {}) {
  const target = resolveReviewTarget(cwd, { base: options.base, scope: options.scope });
  const context = collectReviewContext(cwd, target, { skipPaths: options.skipPaths ?? [] });

  const r1TemplateOpts = {
    focusText: options.focusText ?? "",
    policyFocus: options.policyFocus ?? options.focusText ?? ""
  };

  const r1Jobs = [];
  if (!options.skipCodex) {
    r1Jobs.push(
      runCodexStructured(
        cwd,
        backends,
        { ...options, maxTurns: options.maxTurnsR1 },
        buildR1Prompt("codex", context, r1TemplateOpts),
        "r1"
      )
    );
  } else {
    r1Jobs.push(Promise.resolve({ agent: "codex", skipped: true, reason: "skip", stdout: "" }));
  }

  if (!options.skipGrok) {
    r1Jobs.push(
      runGrokStructured(
        cwd,
        backends,
        { ...options, maxTurns: options.maxTurnsR1 },
        buildR1Prompt("grok", context, r1TemplateOpts)
      )
    );
  } else {
    r1Jobs.push(Promise.resolve({ agent: "grok", skipped: true, reason: "skip", stdout: "" }));
  }

  const r1Raw = await Promise.all(r1Jobs);
  const claudeDoc = await loadClaudeDoc(options);

  const r1Docs = [];
  const r1Results = [];
  for (const raw of r1Raw) {
    if (raw.skipped) {
      r1Results.push(raw);
      continue;
    }
    const doc = parseAgentFindings(raw.stdout, raw.agent);
    r1Docs.push(doc);
    r1Results.push({ ...raw, findings: doc });
  }
  if (claudeDoc) {
    r1Docs.push(claudeDoc);
    r1Results.push({
      agent: "claude",
      backend: "claude-findings-file",
      status: 0,
      stdout: JSON.stringify(claudeDoc, null, 2),
      findings: claudeDoc,
      model: "claude-session",
      skipped: false
    });
  }

  const r2Results = [];
  const critiqueStats = [];
  if (options.deliberatePeer !== false) {
    const severities = options.peerCritiqueSeverities ?? null;
    const codexDoc = r1Docs.find((d) => d.agent === "codex" && d.parseOk);
    const grokDoc = r1Docs.find((d) => d.agent === "grok" && d.parseOk);

    const critiqued = new Map();
    for (const doc of [codexDoc, grokDoc, claudeDoc?.parseOk ? claudeDoc : null].filter(Boolean)) {
      const filtered = filterDocForCritique(doc, severities);
      critiqued.set(doc.agent, filtered.doc);
      critiqueStats.push({ agent: doc.agent, critiqued: filtered.critiqued, total: filtered.total });
    }

    const peerJobs = [];
    const codexSlim = critiqued.get("codex");
    const grokSlim = critiqued.get("grok");
    const claudeSlim = critiqued.get("claude");

    if (codexSlim?.findings.length && !options.skipGrok) {
      peerJobs.push(
        runGrokStructured(cwd, backends, r2Options(options), buildR2Prompt("grok", "codex", codexSlim, context)).then(
          (r) => ({ ...r, aboutAgent: "codex", role: "peer" })
        )
      );
    }

    if (grokSlim?.findings.length && !options.skipCodex) {
      peerJobs.push(
        runCodexStructured(
          cwd,
          backends,
          r2Options(options),
          buildR2Prompt("codex", "grok", grokSlim, context),
          "r2"
        ).then((r) => ({ ...r, aboutAgent: "grok", role: "peer" }))
      );
    }

    if (claudeSlim?.findings.length) {
      if (!options.skipGrok) {
        peerJobs.push(
          runGrokStructured(
            cwd,
            backends,
            r2Options(options),
            buildR2Prompt("grok", "claude", claudeSlim, context)
          ).then((r) => ({ ...r, aboutAgent: "claude", role: "peer" }))
        );
      }
      if (!options.skipCodex) {
        peerJobs.push(
          runCodexStructured(
            cwd,
            backends,
            r2Options(options),
            buildR2Prompt("codex", "claude", claudeSlim, context),
            "r2-claude"
          ).then((r) => ({ ...r, aboutAgent: "claude", role: "peer" }))
        );
      }
    }

    if (peerJobs.length) {
      r2Results.push(...(await Promise.all(peerJobs)));
    }
  }

  let merged = mergeFindings(r1Docs);
  merged = applyPeerVotes(
    merged,
    r2Results
      .filter((r) => !r.skipped)
      .map((r) => ({
        agent: r.agent,
        aboutAgent: r.aboutAgent,
        stdout: r.stdout
      }))
  );

  const rawMissedDocs = [];
  for (const r of r2Results) {
    if (r.skipped) continue;
    try {
      const obj = extractJsonObject(r.stdout);
      if (obj?.missed?.length) {
        rawMissedDocs.push(
          parseAgentFindings(
            JSON.stringify({ agent: r.agent, findings: obj.missed, summary: obj.summary ?? "" }),
            r.agent
          )
        );
      }
    } catch {
      /* ignore */
    }
  }
  const missedDocs = rawMissedDocs.length ? dedupeAgainst(merged, rawMissedDocs) : [];
  if (missedDocs.length) {
    const missedMerged = mergeFindings(missedDocs);
    const additions = missedMerged.all.map((m) => ({ ...m, fromPeerMissed: true }));
    const all = [...merged.all, ...additions];
    merged = {
      ...merged,
      all,
      consensus: all.filter((m) => m.consensus),
      unique: all.filter((m) => !m.consensus)
    };
  }

  merged = applyConsensusPolicy(merged, options.requireConsensusFor ?? []);

  let debates = [];
  if ((options.debateRounds ?? 0) > 0) {
    const entries = buildDebateEntries(merged, options);
    debates = await runDebateRounds(cwd, backends, options, entries);
    merged = applyDebateOutcomes(merged, debates);
  }

  const report = renderDeliberationReport({
    context,
    options,
    r1Results,
    r2Results,
    merged,
    critiqueStats,
    debates,
    claudeIncluded: Boolean(claudeDoc)
  });

  return {
    mode: "deliberate",
    context: {
      branch: context.branch,
      head: context.head,
      snapshotId: context.snapshotId,
      target: context.target,
      summary: context.summary
    },
    r1: r1Results,
    r2: r2Results,
    merged,
    debates,
    claudeIncluded: Boolean(claudeDoc),
    report
  };
}

function formatExit(result) {
  return `${result.status}${result.timedOut ? " (timed out)" : ""}${result.truncated ? " (output truncated)" : ""}`;
}

function shortHead(head) {
  return head === "(no commits)" ? head : head.slice(0, 12);
}

function renderDeliberationReport({
  context,
  options,
  r1Results,
  r2Results,
  merged,
  critiqueStats,
  debates,
  claudeIncluded
}) {
  const lines = [];
  lines.push(`# Council Deliberation`);
  lines.push("");
  lines.push("## Protocol");
  lines.push("1. **Round 1 - Independent:** each agent reviews without seeing the others.");
  lines.push("2. **Round 2 - Peer critique:** agents vote agree/disagree/uncertain on each other's findings.");
  lines.push("3. **Claude synthesis (you):** verify contested items, decide fixes - do not rubber-stamp.");
  lines.push("");
  lines.push("## Snapshot");
  lines.push(`- Target: **${context.target.label}**`);
  lines.push(`- Branch: \`${context.branch}\` · HEAD: \`${shortHead(context.head)}\``);
  lines.push(`- Snapshot: \`${context.snapshotId}\``);
  lines.push(`- Diff summary: ${context.summary}`);
  lines.push(`- Claude R1 file: ${claudeIncluded ? "yes" : "no (run /council:deliberate so Claude writes findings first)"}`);
  if (options.policySource) lines.push(`- Policy: \`${options.policySource}\``);
  if (options.focusText) lines.push(`- Focus: ${options.focusText}`);
  if (critiqueStats?.length) {
    const stats = critiqueStats.map((s) => `${s.agent}: ${s.critiqued}/${s.total}`).join(", ");
    lines.push(
      `- R2 critique scope (severities: ${(options.peerCritiqueSeverities ?? []).join(",") || "all"}): ${stats}`
    );
  }
  lines.push("");

  lines.push(renderMergedMarkdown(merged, { includeVotes: true }));

  if (debates?.length) {
    lines.push(renderDebateSection(debates));
  }

  lines.push("## Round 1 - Independent reviews");
  for (const r of r1Results) {
    lines.push(`### ${r.agent}`);
    if (r.skipped) {
      lines.push(`_Skipped:_ ${r.reason}`);
      lines.push("");
      continue;
    }
    lines.push(`Backend: ${r.backend ?? "?"} · Model: ${r.model ?? "?"} · Exit: ${formatExit(r)}`);
    const doc = r.findings;
    if (doc?.parseOk) {
      lines.push(`Verdict: **${doc.verdict}**`);
      lines.push(doc.summary);
      lines.push("");
      lines.push("```json");
      lines.push(JSON.stringify({ agent: doc.agent, verdict: doc.verdict, findings: doc.findings }, null, 2));
      lines.push("```");
    } else {
      lines.push("_Structured parse failed - raw output:_");
      lines.push("");
      lines.push(r.stdout?.trim() || r.stderr?.trim() || "(empty)");
    }
    lines.push("");
  }

  if (r2Results.length) {
    lines.push("## Round 2 - Peer critiques");
    for (const r of r2Results) {
      lines.push(`### ${r.agent} -> ${r.aboutAgent}`);
      if (r.skipped) {
        lines.push(`_Skipped:_ ${r.reason}`);
        continue;
      }
      lines.push(`Exit: ${formatExit(r)}`);
      lines.push("");
      lines.push(r.stdout?.trim() || r.stderr?.trim() || "(empty)");
      lines.push("");
    }
  }

  lines.push("## Your turn (Claude) - final peer evaluation");
  lines.push("1. If you have not already: write your **independent** findings (same JSON schema).");
  lines.push("2. Vote on Codex + Grok consensus and contested items (agree/disagree/uncertain).");
  lines.push("3. Produce a **decision table**: Fix now / Verify / Ignore - with `file:line` checks.");
  lines.push("4. Do **not** implement fixes unless the user asks.");
  lines.push("");

  if (options.requireConsensusFor?.length) {
    lines.push("## Policy: require consensus for");
    lines.push(options.requireConsensusFor.map((c) => `- ${c}`).join("\n"));
    lines.push("");
    lines.push("Unique findings in these categories need extra human/Claude scrutiny before acting.");
    lines.push("");
  }

  return lines.join("\n");
}
