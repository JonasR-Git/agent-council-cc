import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { resolveStateDir } from "./state.mjs";

/**
 * A resume cache is only valid when the prompt-shaping inputs match too, not
 * just the diff. Fold focus/policy/models/effort into a short context key so a
 * different --focus or --codex-model does not reuse the wrong cached R1.
 */
export function resumeContextKey(options = {}) {
  const parts = [
    options.focusText ?? "",
    options.policyFocus ?? "",
    options.codexModel ?? "",
    options.grokModel ?? "",
    options.grokEffort ?? "",
    options.claudeModel ?? "",
    options.claudeBackend ?? "",
    options.base ?? "",
    options.scope ?? ""
  ].join("");
  return createHash("sha256").update(parts).digest("hex").slice(0, 12);
}

function cacheKey(snapshotId, contextKey) {
  return contextKey ? `${snapshotId}__${contextKey}` : String(snapshotId);
}

/**
 * R1 result caching for resumable deliberations. Successful R1 agent outputs
 * are cached per snapshotId; a --resume run reuses them and only re-runs the
 * agents that failed or are missing (e.g. a codex timeout). Keyed by snapshot,
 * so the same diff → same cache; a changed diff → a fresh snapshot → no reuse.
 */
function r1CacheDir(cwd, snapshotId, contextKey) {
  const safe = String(cacheKey(snapshotId, contextKey)).replace(/[^a-zA-Z0-9._+-]+/g, "_");
  return path.join(resolveStateDir(cwd), "r1-cache", safe);
}

export function writeCachedR1(cwd, snapshotId, agent, raw, contextKey) {
  try {
    if (!raw || raw.skipped || raw.status !== 0 || !String(raw.stdout ?? "").trim()) {
      return false;
    }
    const dir = r1CacheDir(cwd, snapshotId, contextKey);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${agent}.json`),
      // Note: sessionId is intentionally NOT cached - a grok session id is only
      // valid within the process that opened it, so a resumed run must never
      // reuse a prior process's (expired) session for debate.
      JSON.stringify({
        agent,
        stdout: raw.stdout,
        model: raw.model ?? null,
        backend: raw.backend ?? null
      }),
      "utf8"
    );
    return true;
  } catch {
    return false;
  }
}

export function readCachedR1(cwd, snapshotId, agent, contextKey) {
  try {
    const file = path.join(r1CacheDir(cwd, snapshotId, contextKey), `${agent}.json`);
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed && typeof parsed.stdout === "string" && parsed.stdout.trim()) {
      return {
        agent,
        backend: `${parsed.backend ?? "cached"} (resumed)`,
        status: 0,
        stdout: parsed.stdout,
        stderr: "",
        model: parsed.model ?? "(cached)",
        // A cross-process grok session is never valid; force null so the debate
        // seeder falls back to fresh slim calls instead of a stale resume.
        sessionId: null,
        timedOut: false,
        truncated: false,
        durationMs: 0,
        resumedFromCache: true
      };
    }
  } catch {
    /* no cache */
  }
  return null;
}

const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const CACHE_MAX_SNAPSHOTS = 50;

/** Age- and count-based cleanup so the R1 cache cannot grow unbounded. */
export function pruneR1Cache(cwd, nowMs) {
  try {
    const root = path.join(resolveStateDir(cwd), "r1-cache");
    const dirs = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => {
        const full = path.join(root, e.name);
        return { full, mtimeMs: fs.statSync(full).mtimeMs };
      });
    const survivors = dirs
      .filter((d) => nowMs - d.mtimeMs <= CACHE_MAX_AGE_MS)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    const remove = dirs.filter((d) => !survivors.slice(0, CACHE_MAX_SNAPSHOTS).includes(d));
    for (const d of remove) {
      fs.rmSync(d.full, { recursive: true, force: true });
    }
  } catch {
    /* ignore */
  }
}
