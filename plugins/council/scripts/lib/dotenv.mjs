import fs from "node:fs";
import path from "node:path";

import { runCommand } from "./process.mjs";

// Auto-load a gitignored `.council.env` (a `KEY=value` / `export KEY=value` file) into process.env —
// like dotenv/direnv — so a user can persist a secret (e.g. OPENROUTER_API_KEY) locally without
// exporting it in every shell. This is the portable, standard pattern; the plugin still reads the key
// ONLY from the environment, so `.council.env` is pure convenience, never a config the repo trusts.
//
// SECURITY: a TRACKED `.council.env` would COMMIT the secret, so we REFUSE to load one that git tracks
// (warn + skip). An already-set env var is NEVER overwritten — an explicit shell `export` always wins.
// FAIL-SOFT: any error is swallowed; convenience must never change a command's outcome.

/** Is `rel` tracked by git under `root`? (exit 0 from `git ls-files --error-unmatch`). */
function gitTracks(root, rel) {
  try {
    return runCommand("git", ["ls-files", "--error-unmatch", rel], { cwd: root }).status === 0;
  } catch {
    return false; // no git / error → treat as untracked (the file is still local-only)
  }
}

/** Parse a minimal dotenv: `KEY=value` or `export KEY=value`, `#` comments, optional surrounding quotes. Pure. */
export function parseDotenv(text) {
  const out = {};
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let val = m[2].trim();
    if (val.length >= 2 && ((val[0] === '"' && val.endsWith('"')) || (val[0] === "'" && val.endsWith("'")))) {
      val = val.slice(1, -1);
    }
    out[m[1]] = val;
  }
  return out;
}

/**
 * Load `${root}/.council.env` into `env` (default process.env). Returns `{ loaded, tracked? }`.
 * `isTracked`/`readFile`/`exists`/`warn` are injectable so tests need no fs/git. Never overwrites an
 * existing env var; refuses a git-tracked file; totally fail-soft.
 */
export function loadCouncilEnv(root, { env = process.env, warn = (m) => console.error(m), isTracked = gitTracks, readFile = (p) => fs.readFileSync(p, "utf8"), exists = fs.existsSync } = {}) {
  try {
    const dir = String(root ?? ".");
    const file = path.join(dir, ".council.env");
    if (!exists(file)) return { loaded: 0 };
    if (isTracked(dir, ".council.env")) {
      warn("⚠ .council.env is TRACKED by git — refusing to load it (a committed secret leaks). Add `.council.env` to .gitignore, or set the key via the OPENROUTER_API_KEY environment variable instead.");
      return { loaded: 0, tracked: true };
    }
    const vars = parseDotenv(readFile(file));
    let loaded = 0;
    for (const [k, v] of Object.entries(vars)) {
      if (env[k] == null || env[k] === "") {
        env[k] = v; // an explicit shell export already in env is left untouched
        loaded += 1;
      }
    }
    return { loaded };
  } catch {
    return { loaded: 0 };
  }
}
