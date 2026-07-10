import fs from "node:fs";

import { writeFileAtomic } from "./state.mjs";

// Shared JSONL persistence: one JSON object per line, corrupt/blank lines
// skipped on read, size-capped atomic writes. Used by the metrics, ledger, and
// benchmark stores so the read/append/cap logic lives in exactly one place.

/** Read a JSONL file into an array of parsed objects, skipping blank/corrupt lines. */
export function readJsonl(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* skip corrupt line */
    }
  }
  return out;
}

/** Atomically (re)write entries as JSONL, keeping only the last `max` when given. */
export function writeJsonlCapped(file, entries, max) {
  const capped = max && entries.length > max ? entries.slice(-max) : entries;
  writeFileAtomic(file, capped.map((e) => JSON.stringify(e)).join("\n") + (capped.length ? "\n" : ""));
}

/** Append one entry, then cap the file to its last `max` lines (atomic). */
export function appendJsonlCapped(file, entry, max) {
  const entries = readJsonl(file);
  entries.push(entry);
  writeJsonlCapped(file, entries, max);
}
