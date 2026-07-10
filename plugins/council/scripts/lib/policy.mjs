import fs from "node:fs";
import path from "node:path";

import { workspaceRoot } from "./state.mjs";

export const DEFAULT_POLICY = {
  version: 1,
  codex_model: null,
  grok_model: null,
  codex_effort: null,
  grok_effort: null,
  default_mode: "review", // review | deliberate
  base: null,
  scope: "auto",
  focus: "",
  require_consensus_for: [],
  skip_paths: [],
  max_turns_r1: 40,
  max_turns_r2: 25,
  deliberate_peer: true,
  agent_timeout_minutes: 30,
  peer_critique_severities: ["P0", "P1"],
  r2_effort: "medium",
  debate_rounds: 0,
  debate_resume: false,
  solve_writer: "claude",
  budget_guard: 0,
  verify_findings: false,
  reviewers: ["claude", "codex", "grok"],
  claude_backend: "session", // session | spawn
  claude_model: null
};

/**
 * Minimal YAML subset parser for our policy keys.
 * Supports: key: value, key: | multiline, key: with [a, b], and - list items.
 */
export function parseSimpleYaml(text) {
  const lines = String(text).split(/\r?\n/);
  const obj = {};
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith("#")) {
      i += 1;
      continue;
    }

    const m = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!m) {
      i += 1;
      continue;
    }
    const key = m[1];
    let val = stripInlineComment(m[2].trimEnd()).trim();

    if (val === "|" || val === ">") {
      const block = [];
      i += 1;
      while (i < lines.length) {
        const l = lines[i];
        if (l === "" || /^\s/.test(l) || l.startsWith("  ")) {
          block.push(l.replace(/^\s{2}/, ""));
          i += 1;
          continue;
        }
        if (/^[A-Za-z0-9_]+:/.test(l) || l.trim().startsWith("- ")) break;
        break;
      }
      obj[key] = block.join("\n").trim();
      continue;
    }

    if (val === "" || val === null) {
      const list = [];
      let j = i + 1;
      while (j < lines.length) {
        const l = lines[j];
        const lm = l.match(/^\s*-\s+(.*)$/);
        if (!lm) break;
        const item = stripInlineComment(lm[1].trimEnd()).trim();
        list.push(stripQuotes(item));
        j += 1;
      }
      if (list.length) {
        obj[key] = list;
        i = j;
        continue;
      }
      obj[key] = "";
      i += 1;
      continue;
    }

    if (val.startsWith("[") && val.endsWith("]")) {
      obj[key] = val
        .slice(1, -1)
        .split(",")
        .map((s) => stripQuotes(stripInlineComment(s.trimEnd()).trim()))
        .filter(Boolean);
      i += 1;
      continue;
    }

    obj[key] = coerceScalar(stripQuotes(val.trim()));
    i += 1;
  }

  return obj;
}

function stripInlineComment(s) {
  const trimmed = String(s ?? "").trimStart();
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
    return s;
  }
  for (let i = 0; i < s.length; i += 1) {
    if (s[i] === "#" && (i === 0 || /\s/.test(s[i - 1]))) {
      return s.slice(0, i).trimEnd();
    }
  }
  return s;
}

function stripQuotes(s) {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function coerceScalar(s) {
  if (s === "true") return true;
  if (s === "false") return false;
  if (s === "null") return null;
  if (/^-?\d+$/.test(s)) return Number(s);
  return s;
}

export function loadPolicy(cwd) {
  const root = workspaceRoot(cwd);
  const candidates = [
    path.join(root, ".council.yml"),
    path.join(root, ".council.yaml"),
    path.join(root, ".council.json"),
    path.join(root, ".claude", "council.yml"),
    path.join(root, ".claude", "council.json")
  ];

  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, "utf8");
    let parsed;
    if (file.endsWith(".json")) {
      parsed = JSON.parse(text);
    } else {
      parsed = parseSimpleYaml(text);
    }
    return {
      ...DEFAULT_POLICY,
      ...parsed,
      _source: file,
      _root: root
    };
  }

  return { ...DEFAULT_POLICY, _source: null, _root: root };
}

export function mergeOptionsWithPolicy(options, policy) {
  const timeoutMinutes = Number(policy.agent_timeout_minutes ?? DEFAULT_POLICY.agent_timeout_minutes);
  const policyTimeoutMs = Number.isFinite(timeoutMinutes) && timeoutMinutes > 0 ? timeoutMinutes * 60_000 : null;
  // `reviewers` (policy or flag) says WHO participates; an agent absent from the
  // list is skipped. Explicit --skip-<agent> flags still force-skip on top.
  const reviewers = normalizeReviewers(options.reviewers ?? policy.reviewers ?? DEFAULT_POLICY.reviewers);
  const reviewerSet = new Set(reviewers);
  return {
    ...options,
    adversarial: Boolean(options.adversarial),
    deliberate: Boolean(options.deliberate),
    reviewers,
    skipCodex: Boolean(options.skipCodex) || !reviewerSet.has("codex"),
    skipGrok: Boolean(options.skipGrok) || !reviewerSet.has("grok"),
    skipClaude: Boolean(options.skipClaude) || !reviewerSet.has("claude"),
    claudeBackend: normalizeClaudeBackend(options.claudeBackend ?? policy.claude_backend),
    claudeModel: options.claudeModel ?? policy.claude_model ?? null,
    claudeFindingsPath: options.claudeFindingsPath ?? null,
    claudeFindingsWaitPath: options.claudeFindingsWaitPath ?? null,
    waitTimeoutMs: options.waitTimeoutMs ?? null,
    agentTimeoutMs: options.agentTimeoutMs ?? policyTimeoutMs,
    base: options.base ?? policy.base ?? undefined,
    scope: options.scope ?? policy.scope ?? "auto",
    codexModel: options.codexModel ?? options["codex-model"] ?? policy.codex_model ?? options.model,
    grokModel: options.grokModel ?? options["grok-model"] ?? policy.grok_model ?? options.model,
    codexEffort: options.codexEffort ?? options["codex-effort"] ?? policy.codex_effort,
    grokEffort: options.grokEffort ?? options["grok-effort"] ?? policy.grok_effort,
    focusText:
      (options.focusText && String(options.focusText).trim()) ||
      (policy.focus ? String(policy.focus).trim() : ""),
    maxTurnsR1: options.maxTurnsR1 ?? policy.max_turns_r1 ?? 40,
    maxTurnsR2: options.maxTurnsR2 ?? policy.max_turns_r2 ?? 25,
    deliberatePeer: options.deliberatePeer ?? policy.deliberate_peer !== false,
    requireConsensusFor: options.requireConsensusFor ?? policy.require_consensus_for ?? [],
    skipPaths: options.skipPaths ?? policy.skip_paths ?? [],
    peerCritiqueSeverities: normalizeSeverityList(
      options.peerCritiqueSeverities ?? policy.peer_critique_severities ?? DEFAULT_POLICY.peer_critique_severities
    ),
    r2Effort: options.r2Effort ?? policy.r2_effort ?? DEFAULT_POLICY.r2_effort,
    debateRounds: clampDebateRounds(options.debateRounds ?? policy.debate_rounds ?? 0),
    debateResume: options.debateResume ?? policy.debate_resume === true,
    solveWriter: options.solveWriter ?? policy.solve_writer ?? "claude",
    budgetGuard: clampPercent(options.budgetGuard ?? policy.budget_guard ?? 0),
    forceBudget: options.forceBudget ?? false,
    resume: options.resume ?? false,
    verifyFindings: options.verifyFindings ?? policy.verify_findings === true,
    policySource: policy._source
  };
}

function clampPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(100, n);
}

const VALID_REVIEWERS = new Set(["claude", "codex", "grok"]);

export function normalizeReviewers(value) {
  const list = Array.isArray(value) ? value : String(value ?? "").split(",");
  const normalized = list.map((s) => String(s).trim().toLowerCase()).filter((s) => VALID_REVIEWERS.has(s));
  return normalized.length ? [...new Set(normalized)] : ["claude", "codex", "grok"];
}

/**
 * Tokens the caller passed that are NOT valid reviewers. Lets the CLI warn on a
 * typo (`--reviewers gork`) instead of silently falling back to all three -
 * running MORE reviewers than intended is the opposite of the user's intent.
 * Returns [] for empty/null input (the legitimate "use defaults" case).
 */
export function unknownReviewers(value) {
  if (value == null || value === "") return [];
  const list = Array.isArray(value) ? value : String(value).split(",");
  return list
    .map((s) => String(s).trim())
    .filter((s) => s && !VALID_REVIEWERS.has(s.toLowerCase()));
}

/** session | spawn, case-insensitive; anything else degrades to the safe session backend. */
export function normalizeClaudeBackend(value) {
  return String(value ?? "").trim().toLowerCase() === "spawn" ? "spawn" : "session";
}

function normalizeSeverityList(value) {
  const list = Array.isArray(value) ? value : String(value ?? "").split(",");
  // "all" (or an explicit empty policy list) means: critique every finding.
  if (Array.isArray(value) && value.length === 0) return [];
  if (list.some((s) => String(s).trim().toLowerCase() === "all")) return [];
  const valid = new Set(["P0", "P1", "P2", "nit"]);
  const normalized = list
    .map((s) => {
      const token = String(s).trim();
      return token.toLowerCase() === "nit" ? "nit" : token.toUpperCase();
    })
    .filter((s) => valid.has(s));
  return normalized.length ? normalized : ["P0", "P1"];
}

function clampDebateRounds(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(Math.floor(n), 2);
}
