import fs from "node:fs";
import path from "node:path";

import {
  READONLY_DISALLOWED_TOOLS,
  interpolate,
  loadPrompt,
  makeFenceNonce,
  runCodexStructured,
  runGrokStructured,
  waitForFile
} from "./agents.mjs";
import { runClaudeStructured } from "./claude-agent.mjs";
import { applyDebateOutcomes, renderDebateSection, runDebateRounds } from "./debate.mjs";
import {
  applyConsensusPolicy,
  applyPeerVotes,
  dedupeAgainst,
  extractJsonObject,
  mergeFindings,
  parseAgentFindings,
  parseCritiqueVotes,
  renderMergedMarkdown,
  slimFindingsDoc
} from "./findings.mjs";
import { collectReviewContext, resolveReviewTarget } from "./git-context.mjs";
import { recordAndAnnotate } from "./ledger.mjs";
import { pruneR1Cache, readCachedR1, resumeContextKey, writeCachedR1 } from "./resume.mjs";
import { annotateScopes } from "./scope.mjs";
import { verifyFindings } from "./verify.mjs";
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
  const nonce = makeFenceNonce();
  return interpolate(template, {
    AGENT: agent,
    TARGET_LABEL: context.target.label,
    BRANCH: context.branch,
    HEAD: context.head,
    SNAPSHOT_ID: context.snapshotId,
    USER_FOCUS: options.focusText || "None",
    POLICY_FOCUS: options.policyFocus || options.focusText || "None",
    NONCE: nonce,
    REVIEW_INPUT: context.content
  });
}

function buildR2Prompt(agent, aboutAgent, aboutFindings, context) {
  const template = loadPrompt("r2-peer-critique");
  const nonce = makeFenceNonce();
  return interpolate(template, {
    AGENT: agent,
    ABOUT_AGENT: aboutAgent,
    NONCE: nonce,
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
    grokEffort: options.r2Effort ?? options.grokEffort,
    // Capture grok critic sessions so debate counters can resume them.
    captureGrokSession: Boolean(options.debateRounds >= 2 && options.debateResume)
  };
}

function buildDebateEntries(merged, options, sessions = {}, criticSessions = {}) {
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
        authorSessionId: sessions[author] ?? null,
        // The critic critiqued this author, so the relevant grok session is the
        // one keyed by the author it was about.
        criticSessionId: critic === "grok" ? criticSessions[author] ?? null : null,
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
  const onPhase = typeof options.onPhase === "function" ? options.onPhase : () => {};
  onPhase("collecting-context");
  const target = resolveReviewTarget(cwd, { base: options.base, scope: options.scope });
  const context = collectReviewContext(cwd, target, { skipPaths: options.skipPaths ?? [] });

  const r1TemplateOpts = {
    focusText: options.focusText ?? "",
    policyFocus: options.policyFocus ?? options.focusText ?? ""
  };

  // Resume: reuse cached successful R1 outputs for this snapshot so only the
  // failed/missing agents (e.g. a timed-out codex) re-run. The cache key folds
  // in focus/models so a different --focus never reuses the wrong R1.
  const resume = Boolean(options.resume);
  const ctxKey = resumeContextKey({
    focusText: options.focusText,
    policyFocus: options.policyFocus,
    codexModel: options.codexModel,
    grokModel: options.grokModel,
    grokEffort: options.grokEffort,
    // A different Claude backend/model produces different R1 - don't reuse it.
    claudeBackend: options.claudeBackend,
    claudeModel: options.claudeModel,
    base: options.base,
    scope: options.scope
  });
  const cachedCodex = resume ? readCachedR1(cwd, context.snapshotId, "codex", ctxKey) : null;
  const cachedGrok = resume ? readCachedR1(cwd, context.snapshotId, "grok", ctxKey) : null;

  const r1Jobs = [];
  if (options.skipCodex) {
    r1Jobs.push(Promise.resolve({ agent: "codex", skipped: true, reason: "skip", stdout: "" }));
  } else if (cachedCodex) {
    r1Jobs.push(Promise.resolve(cachedCodex));
  } else {
    r1Jobs.push(
      runCodexStructured(
        cwd,
        backends,
        { ...options, maxTurns: options.maxTurnsR1 },
        buildR1Prompt("codex", context, r1TemplateOpts),
        "r1"
      )
    );
  }

  if (options.skipGrok) {
    r1Jobs.push(Promise.resolve({ agent: "grok", skipped: true, reason: "skip", stdout: "" }));
  } else if (cachedGrok) {
    r1Jobs.push(Promise.resolve(cachedGrok));
  } else {
    r1Jobs.push(
      runGrokStructured(
        cwd,
        backends,
        // Capture the session id so debate rebuttals can resume the author's
        // own R1 context (opt-in via debate_resume).
        { ...options, maxTurns: options.maxTurnsR1, captureGrokSession: Boolean(options.debateResume) },
        buildR1Prompt("grok", context, r1TemplateOpts)
      )
    );
  }

  // Claude backend: 'spawn' runs Claude Code headless as an independent reviewer
  // (pinnable model), so the orchestrating session judges neutrally. 'session'
  // (default) keeps Claude's R1 as the orchestrator's own findings file.
  const claudeSpawned = options.claudeBackend === "spawn" && !options.skipClaude;
  const cachedClaude = resume && claudeSpawned ? readCachedR1(cwd, context.snapshotId, "claude", ctxKey) : null;
  if (claudeSpawned) {
    if (cachedClaude) {
      r1Jobs.push(Promise.resolve(cachedClaude));
    } else {
      // No --max-turns on this CLI: the bound is the wall-clock agentTimeoutMs.
      r1Jobs.push(runClaudeStructured(cwd, backends, options, buildR1Prompt("claude", context, r1TemplateOpts)));
    }
  }

  onPhase(resume && (cachedCodex || cachedGrok || cachedClaude) ? "r1 (resuming)" : "r1");
  // Emit per-agent completion so a slow/stuck agent (e.g. a codex backend stall)
  // is visible - you can see grok finished while r1 still waits on codex.
  let r1Done = 0;
  const r1Expected = r1Jobs.length;
  const r1Raw = await Promise.all(
    r1Jobs.map((job) =>
      Promise.resolve(job).then((r) => {
        r1Done += 1;
        if (r && !r.skipped) onPhase(`r1: ${r.agent} done (${r1Done}/${r1Expected})`);
        return r;
      })
    )
  );
  onPhase("r1-done");
  // In spawn mode Claude's findings arrive via r1Raw (spawned CLI); in session
  // mode they come from the orchestrator's findings file. When Claude is not a
  // reviewer (--skip-claude / reviewers omits claude), ingest neither - and do
  // not block on --claude-findings-wait.
  const fileClaudeDoc = claudeSpawned || options.skipClaude ? null : await loadClaudeDoc(options);

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
    // Cache only parse-successful R1 outputs, so a status-0-but-garbage run is
    // retried (not stuck) on the next --resume for this snapshot.
    if (!raw.resumedFromCache && doc.parseOk) writeCachedR1(cwd, context.snapshotId, raw.agent, raw, ctxKey);
  }
  if (options.nowMs) pruneR1Cache(cwd, options.nowMs);
  if (fileClaudeDoc) {
    r1Docs.push(fileClaudeDoc);
    r1Results.push({
      agent: "claude",
      backend: "claude-findings-file",
      status: 0,
      stdout: JSON.stringify(fileClaudeDoc, null, 2),
      findings: fileClaudeDoc,
      model: "claude-session",
      skipped: false
    });
  }
  // Unified claude doc for R2 peer critique / debate, from whichever source.
  const claudeDoc = fileClaudeDoc ?? r1Docs.find((d) => d.agent === "claude") ?? null;

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
      onPhase(`r2 (${peerJobs.length} critiques)`);
      let r2Done = 0;
      const peerResults = await Promise.all(
        peerJobs.map((job) =>
          Promise.resolve(job).then((r) => {
            r2Done += 1;
            if (r && !r.skipped) onPhase(`r2: ${r.agent}->${r.aboutAgent} done (${r2Done}/${peerJobs.length})`);
            return r;
          })
        )
      );
      r2Results.push(
        ...peerResults.map((result) => ({
          ...result,
          critique: result.skipped
            ? null
            : parseCritiqueVotes(result.stdout, result.agent, result.aboutAgent)
        }))
      );
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
        parsed: r.critique
      }))
  );

  const rawMissedDocs = [];
  for (const r of r2Results) {
    if (r.skipped || !r.critique?.parseOk) continue;
    try {
      const obj = r.critique;
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

  // Verification-first: adversarially refute P0/P1 (+ consensus) findings before
  // they are surfaced. Reuses the R2 agent runners at low effort with per-finding
  // evidence only - refuted findings move to a low-confidence bucket. Opt-in.
  let verification = null;
  if (options.verifyFindings) {
    onPhase("verify");
    const vr = await verifyFindings(cwd, backends, options, merged, buildEvidence, context.repoRoot);
    merged = vr.merged;
    verification = { verifiedCount: vr.verifiedCount, refutedCount: vr.refutedCount };
  }

  // Classify each finding localized vs cross-cutting -> preferred deliverable.
  merged = annotateScopes(merged);

  if (options.ledger !== false) {
    merged = recordAndAnnotate(cwd, options.jobId ?? "unknown", merged, options.nowIso ?? new Date().toISOString());
  }

  let debates = [];
  if ((options.debateRounds ?? 0) > 0) {
    onPhase("debate");
    const grokR1 = r1Raw.find((r) => r.agent === "grok" && !r.skipped);
    const sessions = { grok: grokR1?.sessionId ?? null };
    // grok critic sessions keyed by the author they critiqued (aboutAgent).
    const criticSessions = {};
    for (const r of r2Results) {
      if (r.agent === "grok" && r.sessionId && r.aboutAgent) criticSessions[r.aboutAgent] = r.sessionId;
    }
    const entries = buildDebateEntries(merged, options, sessions, criticSessions);
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

  const sections = {
    header: [
      `Target: ${context.target.label}`,
      `Branch: ${context.branch} @ ${shortHead(context.head)}`,
      critiqueStats.length
        ? `R2 critique scope: ${critiqueStats.map((s) => `${s.agent}: ${s.critiqued}/${s.total}`).join(", ")}`
        : null
    ]
      .filter(Boolean)
      .join("\n"),
    merged: renderMergedMarkdown(merged, { includeVotes: true }),
    debate: debates.length ? renderDebateSection(debates) : null
  };

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
    verification,
    claudeIncluded: Boolean(claudeDoc),
    report,
    sections
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
      for (const error of doc?.validationErrors?.slice(0, 3) ?? []) lines.push(`- ${error}`);
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
      if (r.critique && !r.critique.parseOk) {
        lines.push(`_critique ignored: ${r.critique.validationErrors[0]}_`);
      } else if (r.critique?.validationErrors?.length) {
        lines.push(`_Dropped ${r.critique.validationErrors.length} invalid vote field(s)._`);
      }
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
