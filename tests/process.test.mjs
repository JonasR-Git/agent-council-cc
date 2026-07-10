import assert from "node:assert/strict";
import process from "node:process";
import test from "node:test";

import {
  needsCmdShell,
  quoteForCmd,
  runCommandAsync
} from "../plugins/council/scripts/lib/process.mjs";

function spawnBlocked(result) {
  return result.error?.code === "EPERM";
}

test("needsCmdShell only selects Windows bare commands or cmd shims", () => {
  if (process.platform === "win32") {
    assert.equal(needsCmdShell("git"), true);
    assert.equal(needsCmdShell("tool.cmd"), true);
    assert.equal(needsCmdShell("C:\\Program Files\\nodejs\\node.exe"), false);
    assert.equal(needsCmdShell("C:\\tools\\wrap.bat"), true);
  } else {
    assert.equal(needsCmdShell("git"), false);
    assert.equal(needsCmdShell("tool.cmd"), false);
  }
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