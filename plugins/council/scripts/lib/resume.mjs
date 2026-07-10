import fs from "node:fs";
import path from "node:path";

import { resolveStateDir } from "./state.mjs";

/**
 * R1 result caching for resumable deliberations. Successful R1 agent outputs
 * are cached per snapshotId; a --resume run reuses them and only re-runs the
 * agents that failed or are missing (e.g. a codex timeout). Keyed by snapshot,
 * so the same diff → same cache; a changed diff → a fresh snapshot → no reuse.
 */
function r1CacheDir(cwd, snapshotId) {
  const safe = String(snapshotId).replace(/[^a-zA-Z0-9._+-]+/g, "_");
  return path.join(resolveStateDir(cwd), "r1-cache", safe);
}

export function writeCachedR1(cwd, snapshotId, agent, raw) {
  try {
    if (!raw || raw.skipped || raw.status !== 0 || !String(raw.stdout ?? "").trim()) {
      return false;
    }
    const dir = r1CacheDir(cwd, snapshotId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${agent}.json`),
      JSON.stringify({ agent, stdout: raw.stdout, model: raw.model ?? null, backend: raw.backend ?? null }),
      "utf8"
    );
    return true;
  } catch {
    return false;
  }
}

export function readCachedR1(cwd, snapshotId, agent) {
  try {
    const file = path.join(r1CacheDir(cwd, snapshotId), `${agent}.json`);
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed && typeof parsed.stdout === "string" && parsed.stdout.trim()) {
      return {
        agent,
        backend: `${parsed.backend ?? "cached"} (resumed)`,
        status: 0,
        stdout: parsed.stdout,
        stderr: "",
        model: parsed.model ?? "(cached)",
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

export function clearR1Cache(cwd, snapshotId) {
  try {
    fs.rmSync(r1CacheDir(cwd, snapshotId), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}
