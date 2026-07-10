import os from "node:os";
import path from "node:path";

import { collectCodexRateLimits, collectGrokLimits, fetchClaudeLimits } from "./token-usage.mjs";

/**
 * Gather each provider's most constrained window utilization (%), best-effort.
 * Returns { agent: { percent, window, resetsAt } | null }.
 */
export async function gatherWindowPressure(homeDir = os.homedir()) {
  const claude = await fetchClaudeLimits(path.join(homeDir, ".claude"));
  const codex = collectCodexRateLimits(path.join(homeDir, ".codex"));
  const grok = collectGrokLimits(path.join(homeDir, ".grok"));

  const worst = (...windows) => {
    const valid = windows.filter((w) => w && Number.isFinite(Number(w.usedPercent)));
    if (!valid.length) return null;
    return valid.reduce((a, b) => (Number(a.usedPercent) >= Number(b.usedPercent) ? a : b));
  };

  return {
    claude:
      claude && !claude.error
        ? worst(
            claude.fiveHour ? { usedPercent: claude.fiveHour.usedPercent, window: "5h", resetsAt: claude.fiveHour.resetsAt } : null,
            claude.sevenDay ? { usedPercent: claude.sevenDay.usedPercent, window: "weekly", resetsAt: claude.sevenDay.resetsAt } : null
          )
        : null,
    codex: codex ? worst(codex.primary, codex.secondary) : null,
    grok: grok ? { usedPercent: grok.usedPercent, window: grok.window, resetsAt: grok.resetsAt } : null
  };
}

/**
 * Evaluate window pressure against a threshold. `skipAgents` (e.g. skipped
 * backends) are ignored. Returns { breaches: [{agent, percent, window, resetsAt}], checked }.
 */
export function evaluateBudget(pressure, thresholdPercent, skipAgents = []) {
  const skip = new Set(skipAgents);
  const breaches = [];
  const unreadable = [];
  let checked = 0;
  for (const [agent, window] of Object.entries(pressure)) {
    if (skip.has(agent)) continue;
    if (!window || !Number.isFinite(Number(window.usedPercent))) {
      unreadable.push(agent);
      continue;
    }
    checked += 1;
    if (Number(window.usedPercent) >= thresholdPercent) {
      breaches.push({
        agent,
        percent: Number(window.usedPercent),
        window: window.window,
        resetsAt: window.resetsAt ?? null
      });
    }
  }
  return { breaches, checked, unreadable };
}

export function renderBudgetBreaches(breaches) {
  return breaches
    .map((b) => `  ${b.agent}: ${b.percent}% of ${b.window} window used${b.resetsAt ? ` (resets ${b.resetsAt})` : ""}`)
    .join("\n");
}
