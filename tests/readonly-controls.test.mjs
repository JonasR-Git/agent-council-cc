import assert from "node:assert/strict";
import test from "node:test";

import { READONLY_DISALLOWED_TOOLS } from "../plugins/council/scripts/lib/agents.mjs";

// A6 (Windows-sandbox honesty): grok's --sandbox is a NO-OP on native Windows, so the read-only /
// no-exfil control for the GROK seat is this tool DENY-LIST + --disable-web-search, NOT the OS
// sandbox. IMPORTANT scope (council codex-1/claude-1): READONLY_DISALLOWED_TOOLS is applied ONLY
// to the grok seat — the Codex seat passes no tool-gating flag (its containment is the companion
// runtime's own policy), and the Claude seat uses a fail-CLOSED allow-list instead.
//
// These tests are CHANGE-DETECTOR PINS, not a completeness proof: a deny-list is fail-open, so
// they can only assert that names we KNOW are dangerous stay listed — they cannot prove grok
// exposes no other unlisted mutation tool. They guard against accidental narrowing of the list.

test("A6: the deny-list keeps every write/edit/patch tool family denied (Claude- AND grok-native names)", () => {
  const denied = READONLY_DISALLOWED_TOOLS.split(",");
  for (const t of ["Write", "Edit", "NotebookEdit", "search_replace", "str_replace", "apply_patch", "create_file", "write_file", "edit_file"]) {
    assert.ok(denied.includes(t), `write tool must be denied: ${t}`);
  }
});

test("A6: the deny-list keeps every exec/shell tool family denied (incl. grok-native python/code_execution)", () => {
  const denied = READONLY_DISALLOWED_TOOLS.split(",");
  for (const t of ["Bash", "run_command", "run_terminal_cmd", "execute_command", "shell", "terminal", "python", "code_execution"]) {
    assert.ok(denied.includes(t), `exec tool must be denied: ${t}`);
  }
});

test("A6: the deny-list keeps every network/exfil tool family denied (incl. grok-native open_url/http_request/browse_page)", () => {
  const denied = READONLY_DISALLOWED_TOOLS.split(",");
  // The primary exfil vector (web_search/web_fetch) is ALSO killed outright by grok --disable-web-search;
  // these deny entries are belt-and-suspenders for renamed/other network tools.
  for (const t of ["web_search", "web_fetch", "WebSearch", "WebFetch", "browser", "browse_page", "open_url", "http_request", "fetch", "fetch_url", "mcp", "mcp_call"]) {
    assert.ok(denied.includes(t), `network/mcp tool must be denied: ${t}`);
  }
});

test("A6: the deny-list is a bare comma-joined token list (safe for --disallowed-tools, no shell metachars)", () => {
  // It ships as one CLI arg value; it must be plain tokens (no spaces/newlines/quotes) so it is
  // not mangled on the Windows cmd.exe shell path (cf. the A4 newline hazard).
  assert.match(READONLY_DISALLOWED_TOOLS, /^[A-Za-z0-9_,]+$/);
  assert.equal(/[\r\n]/.test(READONLY_DISALLOWED_TOOLS), false);
  assert.equal(READONLY_DISALLOWED_TOOLS.includes(",,"), false, "no empty tokens");
});
