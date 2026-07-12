import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  listJobs,
  readJobFile,
  resolveJobsDir,
  upsertJob,
  withFileLock,
  writeFileAtomic
} from "../plugins/council/scripts/lib/state.mjs";

test("withFileLock runs fn, returns its value, and releases the lock", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "council-lock-"));
  const lock = path.join(dir, "x.lock");
  const result = withFileLock(lock, () => {
    assert.equal(fs.existsSync(lock), true, "lock is held inside fn");
    return 42;
  });
  assert.equal(result, 42);
  assert.equal(fs.existsSync(lock), false, "lock released after fn");
  // reacquire works
  assert.equal(withFileLock(lock, () => "again"), "again");
});

test("withFileLock steals a stale lock and always releases even if fn throws", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "council-lock-"));
  const lock = path.join(dir, "y.lock");
  fs.mkdirSync(lock); // pre-existing (stale) lock
  const ran = withFileLock(lock, () => "stolen", { staleMs: 0 });
  assert.equal(ran, "stolen", "a stale lock is stolen so fn still runs");

  assert.throws(() => withFileLock(lock, () => {
    throw new Error("boom");
  }));
  assert.equal(fs.existsSync(lock), false, "lock released even when fn throws");
});

test("withFileLock throws (never runs fn unlocked) when the lock is held and the timeout expires", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "council-lock-"));
  const lock = path.join(dir, "z.lock");
  fs.mkdirSync(lock); // a live (non-stale) lock held by another holder
  let ran = false;
  // staleMs high so it is never stolen; tiny timeout so the bound fires quickly.
  assert.throws(
    () => withFileLock(lock, () => { ran = true; return "x"; }, { timeoutMs: 40, staleMs: 60_000 }),
    /Timed out acquiring file lock/,
    "must throw rather than run the critical section unlocked"
  );
  assert.equal(ran, false, "fn must NOT run when the lock could not be acquired");
  assert.equal(fs.existsSync(lock), true, "the other holder's lock is left intact (not stolen, not released)");
});

function makeJob(id, patch = {}) {
  return {
    id,
    kind: "review",
    title: `Job ${id}`,
    status: "completed",
    phase: "done",
    summary: id,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, Number(id.replace(/\D/g, "") || 0))).toISOString(),
    updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, Number(id.replace(/\D/g, "") || 0))).toISOString(),
    finishedAt: null,
    pid: null,
    logFile: null,
    exitCode: 0,
    ...patch
  };
}

test("state upsert/list roundtrip, skips corrupt jobs, and prunes without deleting running jobs", () => {
  const previous = process.env.AGENT_COUNCIL_STATE_DIR;
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "council-state-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "council-workspace-"));
  process.env.AGENT_COUNCIL_STATE_DIR = tempRoot;
  try {
    upsertJob(cwd, makeJob("job-1"));
    assert.equal(readJobFile(cwd, "job-1").title, "Job job-1");
    assert.equal(listJobs(cwd)[0].id, "job-1");

    const corrupt = path.join(resolveJobsDir(cwd), "corrupt.json");
    writeFileAtomic(corrupt, "{not json");
    assert.equal(listJobs(cwd).some((job) => job.id === "corrupt"), false);

    upsertJob(
      cwd,
      makeJob("running", {
        status: "running",
        createdAt: "2020-01-01T00:00:00.000Z",
        updatedAt: "2020-01-01T00:00:00.000Z"
      })
    );
    for (let i = 2; i <= 46; i += 1) {
      upsertJob(cwd, makeJob(`job-${i}`));
    }

    assert.ok(listJobs(cwd).length <= 40);
    assert.equal(readJobFile(cwd, "running").status, "running");
  } finally {
    if (previous == null) delete process.env.AGENT_COUNCIL_STATE_DIR;
    else process.env.AGENT_COUNCIL_STATE_DIR = previous;
    fs.rmSync(tempRoot, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});