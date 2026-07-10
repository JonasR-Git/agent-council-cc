import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { runCommand } from "./process.mjs";

const STATE_ROOT_ENV = "AGENT_COUNCIL_STATE_DIR";
const FALLBACK_STATE_ROOT_DIR = path.join(os.homedir(), ".claude", "agent-council-state", "council");
const MAX_JOBS = 40;
const ACTIVE_STATUSES = new Set(["running", "queued"]);

export function nowIso() {
  return new Date().toISOString();
}

export function workspaceRoot(cwd = process.cwd()) {
  const result = runCommand("git", ["rev-parse", "--show-toplevel"], { cwd });
  if (result.status === 0 && result.stdout?.trim()) {
    return result.stdout.trim();
  }
  return cwd;
}

export function resolveStateDir(cwd) {
  const root = workspaceRoot(cwd);
  let canonical = root;
  try {
    canonical = fs.realpathSync.native(root);
  } catch {
    /* keep */
  }
  const slug =
    path.basename(root).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
  const stateRoot = process.env[STATE_ROOT_ENV] || FALLBACK_STATE_ROOT_DIR;
  return path.join(stateRoot, `${slug}-${hash}`);
}

export function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), "jobs");
}

function resolveStateRoot() {
  return process.env[STATE_ROOT_ENV] || FALLBACK_STATE_ROOT_DIR;
}

/** All per-workspace jobs dirs under the state root (for --global history). */
export function listAllJobsDirs() {
  const root = resolveStateRoot();
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => ({ workspace: e.name, jobsDir: path.join(root, e.name, "jobs") }))
      .filter((d) => fs.existsSync(d.jobsDir));
  } catch {
    return [];
  }
}

export function ensureStateDir(cwd) {
  fs.mkdirSync(resolveJobsDir(cwd), { recursive: true });
}

export function writeFileAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, "utf8");
  // Windows AV/indexers hold transient locks: retry the rename, then try
  // removing the destination first; only fall back to a direct (non-atomic)
  // write as the last resort.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (error) {
      const code = /** @type {NodeJS.ErrnoException} */ (error).code;
      if (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES") {
        break;
      }
    }
  }
  try {
    fs.rmSync(file, { force: true });
    fs.renameSync(tmp, file);
    return;
  } catch {
    /* fall through */
  }
  try {
    fs.writeFileSync(file, data, "utf8");
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
}

function sleepSync(ms) {
  // Dependency-free synchronous sleep for the lock retry loop.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Run `fn` while holding a cross-process advisory lock (an atomically-created
 * lock directory). Serializes read-modify-write on a shared file across
 * concurrently-finishing council jobs. A stale lock (older than `staleMs`, e.g.
 * from a crashed process) is stolen; if the lock can't be taken within
 * `timeoutMs`, `fn` runs anyway (best-effort - never block a run on the lock).
 */
export function withFileLock(lockPath, fn, { timeoutMs = 5000, staleMs = 30_000 } = {}) {
  const start = Date.now();
  let held = false;
  for (;;) {
    try {
      fs.mkdirSync(lockPath); // atomic: throws EEXIST if another holder exists
      held = true;
      break;
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== "EEXIST") break; // unexpected -> proceed unlocked
      try {
        if (Date.now() - fs.statSync(lockPath).mtimeMs > staleMs) {
          fs.rmSync(lockPath, { recursive: true, force: true });
          continue; // stole a stale lock; retry immediately
        }
      } catch {
        continue; // lock vanished between mkdir and stat; retry
      }
      if (Date.now() - start > timeoutMs) break; // give up waiting -> proceed unlocked
      sleepSync(25);
    }
  }
  try {
    return fn();
  } finally {
    if (held) {
      try {
        fs.rmSync(lockPath, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }
}

export function generateJobId(prefix = "council") {
  return `${prefix}-${randomBytes(4).toString("hex")}`;
}

export function resolveArtifactsDir(cwd, jobId) {
  return path.join(resolveStateDir(cwd), "artifacts", jobId);
}

const ARTIFACT_INLINE_CHARS = 4000;

/**
 * Persist each agent result's full stdout/stderr as sidecar files and return
 * slim result copies for the job JSON (stateVersion 2). Reports must be
 * rendered from the in-memory results BEFORE calling this.
 */
export function archiveJobResults(cwd, jobId, results) {
  if (!Array.isArray(results) || !results.length) {
    return results ?? null;
  }
  const dir = resolveArtifactsDir(cwd, jobId);
  fs.mkdirSync(dir, { recursive: true });
  return results.map((result, index) => {
    if (!result || result.skipped) {
      return result;
    }
    const label = [result.agent ?? "agent", result.role ?? result.aboutAgent ?? `r${index}`, index]
      .map((part) => String(part).replace(/[^a-zA-Z0-9._-]+/g, "-"))
      .join("-");
    const artifactFile = path.join(dir, `${label}.txt`);
    const body = `# stdout\n${result.stdout ?? ""}\n\n# stderr\n${result.stderr ?? ""}\n`;
    try {
      fs.writeFileSync(artifactFile, body, "utf8");
    } catch {
      return result;
    }
    const slim = { ...result, artifactFile };
    for (const key of ["stdout", "stderr"]) {
      const text = String(result[key] ?? "");
      if (text.length > ARTIFACT_INLINE_CHARS) {
        slim[key] = `${text.slice(0, ARTIFACT_INLINE_CHARS)}\n[... truncated, full output in ${artifactFile} ...]`;
      }
    }
    return slim;
  });
}

function jobFile(cwd, jobId) {
  return path.join(resolveJobsDir(cwd), `${jobId}.json`);
}

export function writeJobFile(cwd, jobId, job) {
  ensureStateDir(cwd);
  const file = jobFile(cwd, jobId);
  writeFileAtomic(file, `${JSON.stringify(job, null, 2)}\n`);
  return file;
}

export function readJobFile(cwd, jobId) {
  const file = jobFile(cwd, jobId);
  if (!fs.existsSync(file)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function readJobEntries(cwd) {
  const dir = resolveJobsDir(cwd);
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      const file = path.join(dir, name);
      try {
        return { file, job: JSON.parse(fs.readFileSync(file, "utf8")) };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function slimJob(job) {
  return {
    id: job.id,
    kind: job.kind,
    title: job.title,
    status: job.status,
    phase: job.phase,
    summary: job.summary,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    finishedAt: job.finishedAt ?? null,
    pid: job.pid ?? null,
    logFile: job.logFile ?? null,
    exitCode: job.exitCode ?? null
  };
}

function createdAtMs(job) {
  const time = Date.parse(job.createdAt ?? "");
  return Number.isFinite(time) ? time : 0;
}

export function pruneJobs(cwd) {
  const entries = readJobEntries(cwd);
  if (entries.length <= MAX_JOBS) {
    return;
  }

  let count = entries.length;
  const removable = entries
    .filter(({ job }) => !ACTIVE_STATUSES.has(job.status))
    .sort((a, b) => createdAtMs(a.job) - createdAtMs(b.job));

  for (const { file, job } of removable) {
    if (count <= MAX_JOBS) {
      break;
    }
    try {
      fs.unlinkSync(file);
    } catch {
      /* ignore */
    }
    const logFiles = new Set([
      job.logFile,
      path.join(path.dirname(file), `${path.basename(file, ".json")}.log`)
    ]);
    for (const logFile of logFiles) {
      if (!logFile) continue;
      try {
        fs.unlinkSync(logFile);
      } catch {
        /* ignore */
      }
    }
    try {
      fs.rmSync(resolveArtifactsDir(cwd, job.id ?? path.basename(file, ".json")), {
        recursive: true,
        force: true
      });
    } catch {
      /* ignore */
    }
    count -= 1;
  }
}

export function upsertJob(cwd, job) {
  const next = {
    ...job,
    updatedAt: job.updatedAt ?? nowIso()
  };
  writeJobFile(cwd, next.id, next);
  pruneJobs(cwd);
  return next;
}

export function listJobs(cwd) {
  return readJobEntries(cwd)
    .map(({ job }) => slimJob(job))
    .sort((a, b) => createdAtMs(b) - createdAtMs(a))
    .slice(0, MAX_JOBS);
}

export function createJobLogFile(cwd, jobId) {
  ensureStateDir(cwd);
  const logFile = path.join(resolveJobsDir(cwd), `${jobId}.log`);
  fs.writeFileSync(logFile, "", "utf8");
  return logFile;
}

export function appendLogLine(logFile, line) {
  if (logFile) {
    fs.appendFileSync(logFile, `${line}\n`, "utf8");
  }
}
