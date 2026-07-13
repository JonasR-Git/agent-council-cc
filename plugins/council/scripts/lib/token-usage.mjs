import fs from "node:fs";
import path from "node:path";

/**
 * Local, browser-free token usage aggregation. All three CLIs persist token
 * data on disk; none exposes it via a headless command:
 * - Claude Code: ~/.claude/projects/<project>/<session>.jsonl - per-message
 *   usage blocks (input/output/cache_creation/cache_read).
 * - Codex CLI:   ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl - cumulative
 *   total_token_usage events; the last one is the session total.
 * - Grok CLI:    ~/.grok/sessions/<workspace>/<session>/updates.jsonl -
 *   running totalTokens counter; the last value is the session total.
 * Parsing is best-effort: unreadable files are skipped, absent dirs yield zeros.
 */

function listFilesRecursive(dir, sinceMs, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      listFilesRecursive(full, sinceMs, out);
    } else if (entry.isFile()) {
      try {
        if (fs.statSync(full).mtimeMs >= sinceMs) out.push(full);
      } catch {
        /* skip */
      }
    }
  }
  return out;
}

export function collectClaudeTokens(claudeDir, sinceMs) {
  const usage = { sessions: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
  const projectsDir = path.join(claudeDir, "projects");
  const files = listFilesRecursive(projectsDir, sinceMs).filter((f) => f.endsWith(".jsonl"));
  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    let counted = false;
    for (const line of text.split("\n")) {
      const at = line.indexOf('"usage":{');
      if (at === -1) continue;
      try {
        const entry = JSON.parse(line);
        const u = entry?.message?.usage ?? entry?.usage;
        if (!u || typeof u !== "object") continue;
        usage.inputTokens += Number(u.input_tokens) || 0;
        usage.outputTokens += Number(u.output_tokens) || 0;
        usage.cacheReadTokens += Number(u.cache_read_input_tokens) || 0;
        usage.cacheCreationTokens += Number(u.cache_creation_input_tokens) || 0;
        counted = true;
      } catch {
        /* skip line */
      }
    }
    if (counted) usage.sessions += 1;
  }
  return usage;
}

export function collectCodexTokens(codexDir, sinceMs) {
  const usage = { sessions: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 };
  const sessionsDir = path.join(codexDir, "sessions");
  const files = listFilesRecursive(sessionsDir, sinceMs).filter((f) => f.endsWith(".jsonl"));
  const re = /"total_token_usage":\{[^}]*\}/g;
  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const matches = text.match(re);
    if (!matches?.length) continue;
    try {
      const last = JSON.parse(`{${matches[matches.length - 1]}}`).total_token_usage;
      usage.inputTokens += Number(last.input_tokens) || 0;
      usage.cachedInputTokens += Number(last.cached_input_tokens) || 0;
      usage.outputTokens += Number(last.output_tokens) || 0;
      usage.reasoningOutputTokens += Number(last.reasoning_output_tokens) || 0;
      usage.totalTokens += Number(last.total_tokens) || 0;
      usage.sessions += 1;
    } catch {
      /* skip file */
    }
  }
  return usage;
}

export function collectGrokTokens(grokDir, sinceMs) {
  const usage = { sessions: 0, totalTokens: 0 };
  const sessionsDir = path.join(grokDir, "sessions");
  const files = listFilesRecursive(sessionsDir, sinceMs).filter((f) => f.endsWith("updates.jsonl"));
  const re = /"totalTokens":(\d+)/g;
  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    let last = null;
    for (const match of text.matchAll(re)) {
      last = Number(match[1]);
    }
    if (last != null && Number.isFinite(last)) {
      usage.totalTokens += last;
      usage.sessions += 1;
    }
  }
  return usage;
}

export function collectAllTokenUsage({ homeDir, sinceMs }) {
  return {
    claude: collectClaudeTokens(path.join(homeDir, ".claude"), sinceMs),
    codex: collectCodexTokens(path.join(homeDir, ".codex"), sinceMs),
    grok: collectGrokTokens(path.join(homeDir, ".grok"), sinceMs)
  };
}

function extractJsonAfterKey(text, key) {
  const marker = `"${key}":`;
  const at = text.lastIndexOf(marker);
  if (at === -1) return null;
  const start = text.indexOf("{", at + marker.length);
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function windowLabel(minutes) {
  if (minutes === 300) return "5h";
  if (minutes === 10080) return "weekly";
  return `${minutes}min`;
}

/**
 * Codex writes rate-limit snapshots (5h + weekly windows) into every rollout -
 * fully local, no network. Returns the newest snapshot or null.
 */
export function collectCodexRateLimits(codexDir) {
  const files = listFilesRecursive(path.join(codexDir, "sessions"), 0).filter((f) =>
    f.endsWith(".jsonl")
  );
  files.sort((a, b) => {
    try {
      return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs;
    } catch {
      return 0;
    }
  });
  for (const file of files.slice(0, 10)) {
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const limits = extractJsonAfterKey(text, "rate_limits");
    if (limits?.primary || limits?.secondary) {
      const window = (w) =>
        w
          ? {
              window: windowLabel(Number(w.window_minutes)),
              usedPercent: Number(w.used_percent),
              resetsAt: w.resets_at ? new Date(Number(w.resets_at) * 1000).toISOString() : null
            }
          : null;
      return {
        planType: limits.plan_type ?? null,
        primary: window(limits.primary),
        secondary: window(limits.secondary),
        source: file
      };
    }
  }
  return null;
}

/**
 * Claude's 5h/7d window utilization comes from an OAuth endpoint (the same
 * data /usage shows). Undocumented and may change; the token never leaves
 * this machine except towards api.anthropic.com itself.
 */
export function parseClaudeLimits(payload) {
  if (!payload || typeof payload !== "object") return null;
  const window = (w) =>
    w && typeof w === "object"
      ? { usedPercent: Number(w.utilization), resetsAt: w.resets_at ?? null }
      : null;
  const fiveHour = window(payload.five_hour);
  const sevenDay = window(payload.seven_day);
  if (!fiveHour && !sevenDay) return null;
  return { fiveHour, sevenDay };
}

export async function fetchClaudeLimits(claudeDir, { timeoutMs = 8000 } = {}) {
  let token;
  try {
    const creds = JSON.parse(fs.readFileSync(path.join(claudeDir, ".credentials.json"), "utf8"));
    token = creds?.claudeAiOauth?.accessToken ?? creds?.accessToken;
  } catch {
    return { error: "no local Claude Code credentials found (~/.claude/.credentials.json)" };
  }
  if (!token) {
    return { error: "no OAuth access token in ~/.claude/.credentials.json" };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" },
      signal: controller.signal
    });
    if (!response.ok) {
      return { error: `usage endpoint returned HTTP ${response.status}` };
    }
    const limits = parseClaudeLimits(await response.json());
    return limits ?? { error: "usage endpoint response had no five_hour/seven_day windows" };
  } catch (error) {
    return { error: `usage endpoint unreachable: ${error?.message ?? error}` };
  } finally {
    clearTimeout(timer);
  }
}

const GROK_LOG_TAIL_BYTES = 512 * 1024;

/**
 * The Grok CLI logs its billing/credits config ("billing: fetched credits
 * config") into ~/.grok/logs/unified.jsonl on every run - weekly window only
 * (Grok has no 5h window). Parses the newest complete entry from the log tail.
 */
export function collectGrokLimits(grokDir) {
  const logFile = path.join(grokDir, "logs", "unified.jsonl");
  let tail;
  let fromStart = false;
  try {
    const size = fs.statSync(logFile).size;
    const start = Math.max(0, size - GROK_LOG_TAIL_BYTES);
    // When the tail begins at byte 0 the first line is COMPLETE and must be scanned; only a
    // mid-file tail (start > 0) can slice into a partial first line that we must skip.
    fromStart = start === 0;
    const fd = fs.openSync(logFile, "r");
    try {
      const buffer = Buffer.alloc(size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      tail = buffer.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
  const lines = tail.split("\n");
  const minIndex = fromStart ? 0 : 1;
  for (let i = lines.length - 1; i >= minIndex; i -= 1) {
    if (!lines[i].includes("creditUsagePercent")) continue;
    try {
      const entry = JSON.parse(lines[i]);
      const config = entry?.ctx?.config;
      if (!config || !Number.isFinite(Number(config.creditUsagePercent))) continue;
      return {
        window: config.currentPeriod?.type === "USAGE_PERIOD_TYPE_WEEKLY" ? "weekly" : config.currentPeriod?.type ?? "unknown",
        usedPercent: Number(config.creditUsagePercent),
        resetsAt: config.currentPeriod?.end ?? null,
        fetchedAt: entry.ts ?? entry.time ?? null,
        source: logFile
      };
    } catch {
      /* partial or foreign line - keep scanning */
    }
  }
  return null;
}

function formatWindow(name, w) {
  if (!w) return `  ${name}: (no data)`;
  const reset = w.resetsAt ? ` (resets ${w.resetsAt})` : "";
  return `  ${name}: ${w.usedPercent}% used${reset}`;
}

export function renderLimits({ claude, codex, grok }) {
  const lines = ["Provider window limits:"];
  lines.push("claude (live via OAuth usage endpoint - undocumented, may change):");
  if (claude?.error) {
    lines.push(`  unavailable: ${claude.error}`);
  } else {
    lines.push(formatWindow("5h window", claude?.fiveHour));
    lines.push(formatWindow("weekly", claude?.sevenDay));
  }
  lines.push(`codex (local rollout snapshot${codex?.planType ? `, plan ${codex.planType}` : ""}):`);
  if (!codex) {
    lines.push("  unavailable: no rate_limits snapshot in ~/.codex/sessions");
  } else {
    lines.push(formatWindow(codex.primary?.window === "5h" ? "5h window" : codex.primary?.window ?? "primary", codex.primary));
    lines.push(formatWindow(codex.secondary?.window === "weekly" ? "weekly" : codex.secondary?.window ?? "secondary", codex.secondary));
  }
  lines.push("grok (local CLI billing log; weekly window only - Grok has no 5h window):");
  if (!grok) {
    lines.push("  unavailable: no billing entry in ~/.grok/logs/unified.jsonl (run the grok CLI once)");
  } else {
    lines.push(
      `  ${grok.window}: ${grok.usedPercent}% used${grok.resetsAt ? ` (resets ${grok.resetsAt})` : ""}${grok.fetchedAt ? ` [as of ${grok.fetchedAt}]` : ""}`
    );
  }
  return lines.join("\n");
}

export function renderTokenUsage(tokens, days) {
  const fmt = (n) => Number(n).toLocaleString("en-US");
  return [
    `Local token usage (all sessions on this machine, last ${days} day${days === 1 ? "" : "s"}):`,
    `  claude  sessions=${tokens.claude.sessions}  input=${fmt(tokens.claude.inputTokens)}  output=${fmt(tokens.claude.outputTokens)}  cache-read=${fmt(tokens.claude.cacheReadTokens)}  cache-write=${fmt(tokens.claude.cacheCreationTokens)}`,
    `  codex   sessions=${tokens.codex.sessions}  input=${fmt(tokens.codex.inputTokens)} (cached ${fmt(tokens.codex.cachedInputTokens)})  output=${fmt(tokens.codex.outputTokens)} (reasoning ${fmt(tokens.codex.reasoningOutputTokens)})  total=${fmt(tokens.codex.totalTokens)}`,
    `  grok    sessions=${tokens.grok.sessions}  total=${fmt(tokens.grok.totalTokens)}`,
    "  Notes: parsed from local CLI session logs (~/.claude, ~/.codex, ~/.grok);",
    "  plan quotas/limits are not stored locally - see the provider pointers below."
  ].join("\n");
}
