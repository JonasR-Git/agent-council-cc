import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const STATE_VERSION = 1;
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const FALLBACK_STATE_ROOT_DIR = path.join(os.homedir(), ".claude", "agent-council-state", "council");
const MAX_JOBS = 40;

export function nowIso() {
  return new Date().toISOString();
}

function defaultState() {
  return { version: STATE_VERSION, jobs: [] };
}

export function workspaceRoot(cwd = process.cwd()) {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8",
    shell: process.platform === "win32",
    windowsHide: true
  });
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
  if (!fs.existsSync(stateFile)) return defaultState();
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return { ...defaultState(), ...parsed, jobs: Array.isArray(parsed.jobs) ? parsed.jobs : [] };
  } catch {
    return defaultState();
  }
}

export function saveState(cwd, state) {
  ensureStateDir(cwd);
  fs.writeFileSync(path.join(resolveStateDir(cwd), "state.json"), `${JSON.stringify(state, null, 2)}\n`);
}

export function generateJobId(prefix = "council") {
  return `${prefix}-${randomBytes(4).toString("hex")}`;
}

export function writeJobFile(cwd, jobId, job) {
  ensureStateDir(cwd);
  const file = path.join(resolveJobsDir(cwd), `${jobId}.json`);
  fs.writeFileSync(file, `${JSON.stringify(job, null, 2)}\n`);
  return file;
}

export function readJobFile(cwd, jobId) {
  const file = path.join(resolveJobsDir(cwd), `${jobId}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function upsertJob(cwd, job) {
  const state = loadState(cwd);
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
  const idx = state.jobs.findIndex((j) => j.id === job.id);
  if (idx >= 0) state.jobs[idx] = slim;
  else state.jobs.unshift(slim);
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
  fs.writeFileSync(logFile, "");
  return logFile;
}

export function appendLogLine(logFile, line) {
  if (logFile) fs.appendFileSync(logFile, `${line}\n`);
}
