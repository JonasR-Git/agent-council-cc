/**
 * CommonMark-safe embedding of arbitrary text in markdown code fences.
 *
 * A fence only closes on a run of the SAME character at least as long as the
 * opener, so we pick a delimiter (backtick or tilde) one character longer than
 * the longest run of that character in the body — the body can never terminate
 * its own wrapper. Kept byte-identical between the council and grok plugins
 * (guarded by tests/libsync.test.mjs).
 */

function longestRun(text, char) {
  let longest = 0;
  let current = 0;
  for (const ch of text) {
    if (ch === char) {
      current += 1;
      if (current > longest) longest = current;
    } else {
      current = 0;
    }
  }
  return longest;
}

export function wrapMarkdownFence(text) {
  const body = String(text ?? "");
  const backtickLen = Math.max(3, longestRun(body, "`") + 1);
  const tildeLen = Math.max(3, longestRun(body, "~") + 1);
  // Shorter fence wins; backticks on ties (more familiar to renderers/models).
  const fence = backtickLen <= tildeLen ? "`".repeat(backtickLen) : "~".repeat(tildeLen);
  return `${fence}\n${body}\n${fence}`;
}

/**
 * If `text` ends inside an open fence (e.g. after a hard length clip), append
 * a matching closing fence so the surrounding document structure stays intact.
 */
export function closeDanglingFence(text) {
  const body = String(text ?? "");
  let open = null;
  for (const line of body.split(/\r?\n/)) {
    const m = line.match(/^(`{3,}|~{3,})/);
    if (!m) continue;
    const char = m[1][0];
    const len = m[1].length;
    if (!open) {
      open = { char, len };
    } else if (char === open.char && len >= open.len) {
      open = null;
    }
  }
  if (!open) {
    return body;
  }
  return `${body}\n${open.char.repeat(open.len)}\n[... fence auto-closed after truncation ...]`;
}
