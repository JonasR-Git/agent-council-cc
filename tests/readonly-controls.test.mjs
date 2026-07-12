import assert from "node:assert/strict";
import test from "node:test";

import { READONLY_DISALLOWED_TOOLS } from "../plugins/council/scripts/lib/agents.mjs";

// A6 (Windows-sandbox honesty): grok's --sandbox is a NO-OP on native Windows, so the REAL
// read-only / no-exfil enforcement for the Codex/Grok seats is the tool DENY-LIST, not the OS
// sandbox. These tests pin that the deny-list actually covers every dangerous tool family, so a
// regression that weakened it (trusting the sandbox instead) would fail loudly.

test("A6: READONLY_DISALLOWED_TOOLS denies every write/edit tool family", () => {
  const denied = READONLY_DISALLOWED_TOOLS.split(",");
  for (const t of ["Write", "Edit", "NotebookEdit", "search_replace"]) {
    assert.ok(denied.includes(t), `write tool must be denied: ${t}`);
  }
});

test("A6: READONLY_DISALLOWED_TOOLS denies every exec/shell tool family", () => {
  const denied = READONLY_DISALLOWED_TOOLS.split(",");
  for (const t of ["Bash", "run_command", "run_terminal_cmd", "execute_command", "shell", "terminal"]) {
    assert.ok(denied.includes(t), `exec tool must be denied: ${t}`);
  }
});

test("A6: READONLY_DISALLOWED_TOOLS denies every network/exfil tool family (the real anti-exfil control)", () => {
  const denied = READONLY_DISALLOWED_TOOLS.split(",");
  // These are what actually block exfiltration on native Windows, where --sandbox does nothing.
  for (const t of ["web_search", "web_fetch", "WebSearch", "WebFetch", "browser", "fetch", "mcp", "mcp_call"]) {
    assert.ok(denied.includes(t), `network/mcp tool must be denied: ${t}`);
  }
});

test("A6: the deny-list is a bare comma-joined token list (safe for --disallowed-tools, no shell metachars)", () => {
  // It ships as one CLI arg value; it must be plain tokens (no spaces/newlines/quotes) so it is
  // not mangled on the Windows cmd.exe shell path (cf. the A4 newline hazard).
  assert.match(READONLY_DISALLOWED_TOOLS, /^[A-Za-z0-9_,]+$/);
  assert.equal(/[\r\n]/.test(READONLY_DISALLOWED_TOOLS), false);
});
