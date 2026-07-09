import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveWorkspaceRoot } from "./workspace.mjs";

const STATE_VERSION = 1;
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const FALLBACK_STATE_ROOT_DIR = path.join(os.homedir(), ".claude", "agent-council-state", "grok");
const MAX_JOBS = 40;

function nowIso() {
  return new Date().toISOString();
}

function defaultState() {
  return {
    version: STATE_VERSION,
    config: {},
    jobs: []
  };
}

export function resolveStateDir(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let canonical = workspaceRoot;
  try {
    canonical = fs.realpathSync.native(workspaceRoot);
  } catch {
    /* keep */
  }
  const slug =
    path.basename(workspaceRoot).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") ||
    "workspace";
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
  const pluginDataDir = process.env[PLUGIN_DATA_ENV];
  const stateRoot = pluginDataDir ? path.join(pluginDataDir, "state") : FALLBACK_STATE_ROOT_DIR;
  return path.join(stateRoot, `${slug}-${hash}`);
}

export function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), "jobs");
}

export function ensureStateDir(cwd) {
  fs.mkdirSync(resolveJobsDir(cwd), { recursive: true });
}

export function loadState(cwd) {
  const stateFile = path.join(resolveStateDir(cwd), "state.json");
  if (!fs.existsSync(stateFile)) {
    return defaultState();
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return {
      ...defaultState(),
      ...parsed,
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : []
    };
  } catch {
    return defaultState();
  }
}

export function saveState(cwd, state) {
  ensureStateDir(cwd);
  const stateFile = path.join(resolveStateDir(cwd), "state.json");
  fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export function generateJobId(prefix = "job") {
  return `${prefix}-${randomBytes(4).toString("hex")}`;
}

export function writeJobFile(cwd, jobId, job) {
  ensureStateDir(cwd);
  const file = path.join(resolveJobsDir(cwd), `${jobId}.json`);
  fs.writeFileSync(file, `${JSON.stringify(job, null, 2)}\n`, "utf8");
  return file;
}

export function readJobFile(cwd, jobId) {
  const file = path.join(resolveJobsDir(cwd), `${jobId}.json`);
  if (!fs.existsSync(file)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function upsertJob(cwd, job) {
  const state = loadState(cwd);
  const idx = state.jobs.findIndex((j) => j.id === job.id);
  const slim = {
    id: job.id,
    kind: job.kind,
    title: job.title,
    status: job.status,
    phase: job.phase,
    summary: job.summary,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt ?? nowIso(),
    finishedAt: job.finishedAt ?? null,
    pid: job.pid ?? null,
    logFile: job.logFile ?? null,
    exitCode: job.exitCode ?? null
  };
  if (idx >= 0) {
    state.jobs[idx] = slim;
  } else {
    state.jobs.unshift(slim);
  }
  state.jobs = state.jobs.slice(0, MAX_JOBS);
  saveState(cwd, state);
  writeJobFile(cwd, job.id, job);
  return job;
}

export function listJobs(cwd) {
  return loadState(cwd).jobs;
}

export function createJobLogFile(cwd, jobId) {
  ensureStateDir(cwd);
  const logFile = path.join(resolveJobsDir(cwd), `${jobId}.log`);
  fs.writeFileSync(logFile, "", "utf8");
  return logFile;
}

export function appendLogLine(logFile, line) {
  if (!logFile) {
    return;
  }
  fs.appendFileSync(logFile, `${line}\n`, "utf8");
}

export { nowIso };
