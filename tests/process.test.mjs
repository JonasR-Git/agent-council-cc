import assert from "node:assert/strict";
import process from "node:process";
import test from "node:test";

import {
  needsCmdShell,
  quoteForCmd,
  runCommand,
  runCommandAsync
} from "../plugins/council/scripts/lib/process.mjs";

function spawnBlocked(result) {
  return result.error?.code === "EPERM";
}

test("needsCmdShell only selects Windows bare commands or cmd shims, exempting git (P1)", () => {
  if (process.platform === "win32") {
    // git.exe is a native PE binary (never a .cmd/.bat shim), so it is exempt from the
    // bare-name -> cmd.exe rule: routing it through cmd.exe would fail-close on '%' in
    // legitimate git pretty-format args (e.g. `--format=%H`) - see process.mjs P1 fix.
    assert.equal(needsCmdShell("git"), false);
    assert.equal(needsCmdShell("git.exe"), false);
    assert.equal(needsCmdShell("GIT"), false);
    assert.equal(needsCmdShell("tool.cmd"), true);
    assert.equal(needsCmdShell("C:\\Program Files\\nodejs\\node.exe"), false);
    assert.equal(needsCmdShell("C:\\tools\\wrap.bat"), true);
  } else {
    assert.equal(needsCmdShell("git"), false);
    assert.equal(needsCmdShell("tool.cmd"), false);
  }
});

test("runCommand allows git pretty-format '%' args through on win32 instead of fail-closing (P1)", (t) => {
  if (process.platform !== "win32") {
    t.skip("this pins the Windows cmd.exe-routing fix only");
    return;
  }
  const result = runCommand("git", ["log", "--format=%H", "-n", "1"], { cwd: process.cwd() });
  if (result.error?.code === "ENOENT" || result.error?.code === "EPERM") {
    t.skip("git binary unavailable in this sandbox");
    return;
  }
  assert.doesNotMatch(result.stderr, /Refusing to pass '%'/);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout.trim(), /^[0-9a-f]{40}$/);
});

test("runCommand honors options.timeoutMs on the sync API, not just options.timeout (P2)", () => {
  const start = Date.now();
  // Before the P2 fix, spawnSync only read options.timeout, so a caller passing
  // timeoutMs (the async API's option name) got an inert cap: the child would run
  // to completion instead of being killed at ~200ms.
  const result = runCommand(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], {
    timeoutMs: 200
  });
  const elapsed = Date.now() - start;
  if (result.error?.code === "EPERM") {
    return;
  }
  assert.ok(elapsed < 4000, `expected the timeoutMs cap to cut the child short, took ${elapsed}ms`);
  assert.equal(result.error?.code, "ETIMEDOUT");
});

test("quoteForCmd quotes unsafe tokens and leaves safe tokens alone", () => {
  assert.equal(quoteForCmd("abc-DEF_12:/=\\path"), "abc-DEF_12:/=\\path");
  assert.equal(quoteForCmd("a b & c"), '"a b & c"');
  assert.equal(quoteForCmd('a"b'), '"a\\"b"');
  assert.equal(quoteForCmd("ends \\"), '"ends \\\\"');
});

test("runCommandAsync roundtrips args with spaces and ampersand", async (t) => {
  const result = await runCommandAsync(
    process.execPath,
    ["-e", "console.log(process.argv[1])", "a b & c"],
    { timeoutMs: 5000 }
  );
  if (spawnBlocked(result)) {
    t.skip("child_process.spawn is blocked by this sandbox");
    return;
  }
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.equal(result.stdout.trim(), "a b & c");
});

test("runCommandAsync pipes options.input to the child's stdin", async (t) => {
  const result = await runCommandAsync(
    process.execPath,
    ["-e", "process.stdin.on('data', (d) => process.stdout.write(d))"],
    { input: "hello from stdin", timeoutMs: 5000 }
  );
  if (spawnBlocked(result)) {
    t.skip("child_process.spawn is blocked by this sandbox");
    return;
  }
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.equal(result.stdout.trim(), "hello from stdin");
});

test("runCommandAsync without input closes stdin so stdin-readers see EOF", async (t) => {
  const result = await runCommandAsync(
    process.execPath,
    ["-e", "let n=0; process.stdin.on('data',()=>{n++}); process.stdin.on('end',()=>process.stdout.write('end:'+n))"],
    { timeoutMs: 5000 }
  );
  if (spawnBlocked(result)) {
    t.skip("child_process.spawn is blocked by this sandbox");
    return;
  }
  // stdio[0] is "ignore" with no input; the child should still terminate (EOF),
  // not hang until the timeout.
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.equal(result.timedOut, false);
});

test("runCommandAsync KILLS a never-exiting child at options.timeoutMs (the seat-CLI hang guard)", async (t) => {
  // A seat CLI (grok/codex/claude) that never returns must NOT hang the caller forever. This is exactly
  // what agents.mjs relies on by always passing a bounded timeoutMs (DEFAULT_AGENT_TIMEOUT_MS) — without a
  // timeout, a hung grok.exe hung the whole fix loop live. A child that sleeps 60s under a ~300ms cap must
  // come back promptly as timedOut with status 124.
  const start = Date.now();
  const result = await runCommandAsync(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { timeoutMs: 300 });
  if (spawnBlocked(result)) {
    t.skip("child_process.spawn is blocked by this sandbox");
    return;
  }
  const elapsed = Date.now() - start;
  assert.equal(result.timedOut, true, "a child that never exits is reported timedOut");
  assert.equal(result.status, 124, "a timed-out child returns status 124");
  assert.ok(elapsed < 5000, `expected the ~300ms cap to cut it short, took ${elapsed}ms`);
});

test("runCommandAsync timeout kills long-running process", async (t) => {
  const result = await runCommandAsync(
    process.execPath,
    ["-e", "setTimeout(()=>{}, 60000)"],
    { timeoutMs: 500 }
  );
  if (spawnBlocked(result)) {
    t.skip("child_process.spawn is blocked by this sandbox");
    return;
  }
  assert.equal(result.status, 124);
  assert.equal(result.timedOut, true);
  assert.match(result.stderr, /timed out after 500ms/);
});