import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  applyPeerVotes,
  extractJsonObject,
  mergeFindings,
  parseAgentFindings,
  renderMergedMarkdown
} from "./findings.mjs";
import { collectReviewContext, resolveReviewTarget } from "./git-context.mjs";
import { findGrokBinary } from "./discover.mjs";
import { runCommandAsync } from "./process.mjs";

const PROMPTS_DIR = path.resolve(fileURLToPath(new URL("../../prompts", import.meta.url)));

function loadPrompt(name) {
  return fs.readFileSync(path.join(PROMPTS_DIR, `${name}.md`), "utf8");
}

function interpolate(template, values) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) =>
    values[key] != null ? String(values[key]) : ""
  );
}

function writeTempPrompt(content) {
  const file = path.join(os.tmpdir(), `council-prompt-${Date.now()}-${Math.random().toString(16).slice(2)}.md`);
  fs.writeFileSync(file, content, "utf8");
  return file;
}

/**
 * Run Grok headless with a full prompt (structured R1/R2).
 */
export async function runGrokStructured(cwd, backends, options, prompt) {
  const bin = backends.grok?.bin || findGrokBinary();
  const promptFile = writeTempPrompt(prompt);
  const args = [
    "--prompt-file",
    promptFile,
    "--cwd",
    cwd,
    "--always-approve",
    "--disallowed-tools",
    "search_replace,Write,Edit,NotebookEdit",
    "--max-turns",
    String(options.maxTurns ?? 40),
    "--output-format",
    "plain"
  ];
  if (options.grokModel) args.push("--model", options.grokModel);
  if (options.grokEffort) args.push("--effort", options.grokEffort);

  try {
    const result = await runCommandAsync(bin, args, { cwd });
    return {
      agent: "grok",
      backend: "grok-cli",
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      model: options.grokModel ?? "(default)",
      command: `${bin} --prompt-file …`
    };
  } finally {
    try {
      fs.unlinkSync(promptFile);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Run Codex via companion task (read-only-ish prompt for structured review).
 * Falls back to adversarial-review with focus embedding the prompt snippet.
 */
export async function runCodexStructured(cwd, backends, options, prompt, label) {
  if (!backends.codex?.companionAvailable) {
    return {
      agent: "codex",
      skipped: true,
      reason: "codex companion not found",
      stdout: "",
      stderr: ""
    };
  }

  const companion = backends.codex.companion;
  // Prefer task with explicit prompt file for full structured instructions.
  const promptFile = writeTempPrompt(prompt);
  const args = [companion, "task", "--prompt-file", promptFile];
  if (options.codexModel) args.push("--model", options.codexModel);
  // no --write → companion default read-only sandbox for tasks

  try {
    const result = await runCommandAsync(process.execPath, args, { cwd });
    // If task path fails hard, try adversarial-review with truncated focus
    if (result.status !== 0 && !result.stdout?.trim()) {
      const focus = `Return ONLY JSON findings. Context label: ${label}. Follow structured review schema with agent=codex.`;
      const fallbackArgs = [companion, "adversarial-review"];
      if (options.base) fallbackArgs.push("--base", options.base);
      if (options.scope) fallbackArgs.push("--scope", options.scope);
      if (options.codexModel) fallbackArgs.push("--model", options.codexModel);
      fallbackArgs.push(focus);
      const fb = await runCommandAsync(process.execPath, fallbackArgs, { cwd });
      return {
        agent: "codex",
        backend: "codex-companion-adversarial-fallback",
        status: fb.status,
        stdout: fb.stdout,
        stderr: fb.stderr,
        model: options.codexModel ?? "(default)",
        command: `node … adversarial-review`
      };
    }
    return {
      agent: "codex",
      backend: "codex-companion-task",
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      model: options.codexModel ?? "(default)",
      command: `node … task --prompt-file`
    };
  } finally {
    try {
      fs.unlinkSync(promptFile);
    } catch {
      /* ignore */
    }
  }
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
  const short = context.content.length > 40_000 ? context.content.slice(0, 40_000) + "\n[truncated]" : context.content;
  return interpolate(template, {
    AGENT: agent,
    ABOUT_AGENT: aboutAgent,
    OTHER_FINDINGS_JSON: JSON.stringify(aboutFindings, null, 2),
    REVIEW_INPUT_SHORT: short
  });
}

/**
 * Full deliberation: R1 independent (codex+grok [+claude file]) then R2 cross-critique.
 */
export async function runDeliberation(cwd, backends, options = {}) {
  const target = resolveReviewTarget(cwd, { base: options.base, scope: options.scope });
  const context = collectReviewContext(cwd, target);

  const r1TemplateOpts = {
    focusText: options.focusText ?? "",
    policyFocus: options.policyFocus ?? options.focusText ?? ""
  };

  // --- Round 1: independent ---
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

  // Optional Claude findings from file (written by Claude Code before invoking companion)
  let claudeDoc = null;
  if (options.claudeFindingsPath && fs.existsSync(options.claudeFindingsPath)) {
    const text = fs.readFileSync(options.claudeFindingsPath, "utf8");
    claudeDoc = parseAgentFindings(text, "claude");
  }

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

  // --- Round 2: peer critique (codex↔grok; each also critiques claude if present) ---
  const r2Results = [];
  if (options.deliberatePeer !== false) {
    const codexDoc = r1Docs.find((d) => d.agent === "codex" && d.parseOk);
    const grokDoc = r1Docs.find((d) => d.agent === "grok" && d.parseOk);

    const peerJobs = [];

    if (codexDoc && !options.skipGrok) {
      peerJobs.push(
        runGrokStructured(
          cwd,
          backends,
          { ...options, maxTurns: options.maxTurnsR2 },
          buildR2Prompt("grok", "codex", codexDoc, context)
        ).then((r) => ({ ...r, aboutAgent: "codex", role: "peer" }))
      );
    }

    if (grokDoc && !options.skipCodex) {
      peerJobs.push(
        runCodexStructured(
          cwd,
          backends,
          { ...options, maxTurns: options.maxTurnsR2 },
          buildR2Prompt("codex", "grok", grokDoc, context),
          "r2"
        ).then((r) => ({ ...r, aboutAgent: "grok", role: "peer" }))
      );
    }

    // Cross-critique Claude if provided
    if (claudeDoc?.parseOk) {
      if (!options.skipGrok) {
        peerJobs.push(
          runGrokStructured(
            cwd,
            backends,
            { ...options, maxTurns: options.maxTurnsR2 },
            buildR2Prompt("grok", "claude", claudeDoc, context)
          ).then((r) => ({ ...r, aboutAgent: "claude", role: "peer" }))
        );
      }
      if (!options.skipCodex) {
        peerJobs.push(
          runCodexStructured(
            cwd,
            backends,
            { ...options, maxTurns: options.maxTurnsR2 },
            buildR2Prompt("codex", "claude", claudeDoc, context),
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

  // Collect "missed" findings from peer rounds
  const missedDocs = [];
  for (const r of r2Results) {
    if (r.skipped) continue;
    try {
      const obj = extractJsonObject(r.stdout);
      if (obj?.missed?.length) {
        missedDocs.push(
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
  if (missedDocs.length) {
    const missedMerged = mergeFindings(missedDocs);
    // append unique missed into unique list
    merged = {
      ...merged,
      unique: [...merged.unique, ...missedMerged.all.map((m) => ({ ...m, fromPeerMissed: true }))],
      all: [...merged.all, ...missedMerged.all.map((m) => ({ ...m, fromPeerMissed: true }))]
    };
  }

  const report = renderDeliberationReport({
    context,
    options,
    r1Results,
    r2Results,
    merged,
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
    claudeIncluded: Boolean(claudeDoc),
    report
  };
}

function renderDeliberationReport({ context, options, r1Results, r2Results, merged, claudeIncluded }) {
  const lines = [];
  lines.push(`# Council Deliberation`);
  lines.push("");
  lines.push("## Protocol");
  lines.push("1. **Round 1 — Independent:** each agent reviews without seeing the others.");
  lines.push("2. **Round 2 — Peer critique:** agents vote agree/disagree/uncertain on each other's findings.");
  lines.push("3. **Claude synthesis (you):** verify contested items, decide fixes — do not rubber-stamp.");
  lines.push("");
  lines.push("## Snapshot");
  lines.push(`- Target: **${context.target.label}**`);
  lines.push(`- Branch: \`${context.branch}\` · HEAD: \`${context.head.slice(0, 12)}\``);
  lines.push(`- Snapshot: \`${context.snapshotId}\``);
  lines.push(`- Diff summary: ${context.summary}`);
  lines.push(`- Claude R1 file: ${claudeIncluded ? "yes" : "no (run /council:deliberate so Claude writes findings first)"}`);
  if (options.policySource) lines.push(`- Policy: \`${options.policySource}\``);
  if (options.focusText) lines.push(`- Focus: ${options.focusText}`);
  lines.push("");

  lines.push(renderMergedMarkdown(merged, { includeVotes: true }));

  lines.push("## Round 1 — Independent reviews");
  for (const r of r1Results) {
    lines.push(`### ${r.agent}`);
    if (r.skipped) {
      lines.push(`_Skipped:_ ${r.reason}`);
      lines.push("");
      continue;
    }
    lines.push(`Backend: ${r.backend ?? "?"} · Model: ${r.model ?? "?"} · Exit: ${r.status}`);
    const doc = r.findings;
    if (doc?.parseOk) {
      lines.push(`Verdict: **${doc.verdict}**`);
      lines.push(doc.summary);
      lines.push("");
      lines.push("```json");
      lines.push(JSON.stringify({ agent: doc.agent, verdict: doc.verdict, findings: doc.findings }, null, 2));
      lines.push("```");
    } else {
      lines.push("_Structured parse failed — raw output:_");
      lines.push("");
      lines.push(r.stdout?.trim() || r.stderr?.trim() || "(empty)");
    }
    lines.push("");
  }

  if (r2Results.length) {
    lines.push("## Round 2 — Peer critiques");
    for (const r of r2Results) {
      lines.push(`### ${r.agent} → ${r.aboutAgent}`);
      if (r.skipped) {
        lines.push(`_Skipped:_ ${r.reason}`);
        continue;
      }
      lines.push(`Exit: ${r.status}`);
      lines.push("");
      lines.push(r.stdout?.trim() || r.stderr?.trim() || "(empty)");
      lines.push("");
    }
  }

  lines.push("## Your turn (Claude) — final peer evaluation");
  lines.push("1. If you have not already: write your **independent** findings (same JSON schema).");
  lines.push("2. Vote on Codex + Grok consensus and contested items (agree/disagree/uncertain).");
  lines.push("3. Produce a **decision table**: Fix now / Verify / Ignore — with `file:line` checks.");
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
