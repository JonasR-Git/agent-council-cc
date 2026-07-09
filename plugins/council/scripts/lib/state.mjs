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

export function ensureStateDir(cwd) {
  fs.mkdirSync(resolveJobsDir(cwd), { recursive: true });
}

export function writeFileAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, "utf8");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (error) {
      const code = /** @type {NodeJS.ErrnoException} */ (error).code;
      if (attempt === 0 && (code === "EPERM" || code === "EBUSY")) {
        continue;
      }
      break;
    }
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

export function generateJobId(prefix = "council") {
  return `${prefix}-${randomBytes(4).toString("hex")}`;
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
