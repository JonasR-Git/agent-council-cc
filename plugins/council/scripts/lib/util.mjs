// Small shared pure helpers used across several council lib modules. Kept here
// so a single definition can't drift into subtly-different copies.

export function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

export function firstLines(text, n) {
  return String(text ?? "")
    .split(/\r?\n/)
    .slice(0, n)
    .join("\n")
    .trim();
}

/**
 * Deterministic 32-bit rolling hash as 8 hex chars. Feeds PERSISTED keys
 * (snapshot ids, ledger fingerprints), so the algorithm must stay byte-stable -
 * changing it would orphan every existing on-disk snapshot/fingerprint.
 */
export function hashLite(text) {
  let h = 0;
  for (let i = 0; i < text.length; i += 1) h = (h * 31 + text.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, "0");
}

/** Human-readable exit annotation for a runCommandAsync result. */
export function formatExit(result) {
  return `${result.status}${result.timedOut ? " (timed out)" : ""}${result.truncated ? " (output truncated)" : ""}`;
}
