import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { binaryAvailable } from "./process.mjs";

function exists(file) {
  try {
    return fs.existsSync(file);
  } catch {
    return false;
  }
}

export function newestMatching(dir, predicate) {
  if (!exists(dir)) return null;
  // A probe must never crash the whole command: readdirSync/statSync can throw (ENOTDIR when the
  // path is a file, or an ENOENT race after the exists() check). Degrade to "not found" instead.
  try {
    const entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(dir, e.name))
      .filter(predicate)
      .map((p) => ({ path: p, mtime: fs.statSync(p).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    return entries[0]?.path ?? null;
  } catch {
    return null;
  }
}

/**
 * Find codex-companion.mjs from the installed OpenAI Codex Claude plugin cache,
 * marketplace checkout, or CODEX_COMPANION_PATH.
 */
function findCodexCompanion() {
  if (process.env.CODEX_COMPANION_PATH && exists(process.env.CODEX_COMPANION_PATH)) {
    return process.env.CODEX_COMPANION_PATH;
  }

  const home = os.homedir();
  const cacheRoot = path.join(home, ".claude", "plugins", "cache", "openai-codex", "codex");
  if (exists(cacheRoot)) {
    // Guard the readdir/stat so an ENOTDIR/race at probe time degrades to the next candidate
    // instead of crashing the command.
    try {
      const versions = fs
        .readdirSync(cacheRoot, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => path.join(cacheRoot, e.name, "scripts", "codex-companion.mjs"))
        .filter(exists)
        .map((p) => ({ path: p, mtime: fs.statSync(p).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      if (versions[0]) return versions[0].path;
    } catch {
      /* probe failed — fall through to the marketplace candidate */
    }
  }

  const marketplace = path.join(
    home,
    ".claude",
    "plugins",
    "marketplaces",
    "openai-codex",
    "plugins",
    "codex",
    "scripts",
    "codex-companion.mjs"
  );
  if (exists(marketplace)) return marketplace;

  return null;
}

/**
 * Find grok-companion.mjs from sibling plugin in this marketplace source tree,
 * installed cache, or GROK_COMPANION_PATH.
 */
function findGrokCompanion(fromCouncilRoot) {
  if (process.env.GROK_COMPANION_PATH && exists(process.env.GROK_COMPANION_PATH)) {
    return process.env.GROK_COMPANION_PATH;
  }

  // Sibling in monorepo: .../plugins/council -> .../plugins/grok/scripts/grok-companion.mjs
  if (fromCouncilRoot) {
    const sibling = path.resolve(fromCouncilRoot, "..", "grok", "scripts", "grok-companion.mjs");
    if (exists(sibling)) return sibling;
  }

  const home = os.homedir();
  const cacheRoot = path.join(home, ".claude", "plugins", "cache", "agent-council", "grok");
  const cached = newestMatching(cacheRoot, (dir) =>
    exists(path.join(dir, "scripts", "grok-companion.mjs"))
  );
  if (cached) return path.join(cached, "scripts", "grok-companion.mjs");

  // Also try marketplace source install path patterns
  const marketplaceCandidates = [
    path.join(home, ".claude", "plugins", "marketplaces", "agent-council", "plugins", "grok", "scripts", "grok-companion.mjs"),
    path.join(home, ".claude", "plugins", "marketplaces", "agent-council-cc", "plugins", "grok", "scripts", "grok-companion.mjs")
  ];
  for (const candidate of marketplaceCandidates) {
    if (exists(candidate)) return candidate;
  }

  return null;
}

export function findGrokBinary() {
  const fromEnv = process.env.GROK_BIN || process.env.GROK_PATH;
  if (fromEnv && exists(fromEnv)) return fromEnv;
  const home = os.homedir();
  const candidates = [
    path.join(home, ".grok", "bin", process.platform === "win32" ? "grok.exe" : "grok")
  ];
  for (const c of candidates) {
    if (exists(c)) return c;
  }
  return "grok";
}

export function findClaudeBinary() {
  const fromEnv = process.env.CLAUDE_BIN || process.env.CLAUDE_PATH;
  if (fromEnv && exists(fromEnv)) return fromEnv;
  const home = os.homedir();
  const exe = process.platform === "win32" ? "claude.exe" : "claude";
  const candidates = [
    path.join(home, ".local", "bin", exe),
    path.join(home, ".claude", "local", exe),
    // Older local installs shipped the bare name without the .exe suffix.
    path.join(home, ".claude", "local", "claude")
  ];
  for (const c of candidates) {
    if (exists(c)) return c;
  }
  return "claude";
}

export function probeBackends(cwd, councilRoot, options = {}) {
  // Version probes spawn a child; cap them so a hung CLI can't stall a run.
  const probeOpts = { cwd, timeout: 10_000 };
  const codexCompanion = findCodexCompanion();
  const grokCompanion = findGrokCompanion(councilRoot);
  const grokBin = findGrokBinary();
  const claudeBin = findClaudeBinary();
  const codexCli = binaryAvailable("codex", ["--version"], probeOpts);
  const grokCli = binaryAvailable(grokBin, ["--version"], probeOpts);
  // The Claude version probe is only needed for the spawn backend / doctor /
  // setup. Skip it on the hot review path (probeClaude: false) to avoid paying
  // `claude --version` startup latency on every run when session backend is used.
  const claudeCli =
    options.probeClaude === false
      ? { available: false, detail: "not probed" }
      : binaryAvailable(claudeBin, ["--version"], probeOpts);
  const node = binaryAvailable("node", ["--version"], probeOpts);

  return {
    node,
    codex: {
      companion: codexCompanion,
      companionAvailable: Boolean(codexCompanion),
      cli: codexCli
    },
    grok: {
      companion: grokCompanion,
      companionAvailable: Boolean(grokCompanion),
      bin: grokBin,
      cli: grokCli
    },
    claude: {
      bin: claudeBin,
      cli: claudeCli
    }
  };
}

export function councilPluginRoot() {
  return path.resolve(fileURLToPath(new URL("..", import.meta.url)), "..");
}
