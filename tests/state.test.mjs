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
  writeFileAtomic
} from "../plugins/council/scripts/lib/state.mjs";

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