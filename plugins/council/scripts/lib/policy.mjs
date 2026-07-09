import fs from "node:fs";
import path from "node:path";

import { workspaceRoot } from "./state.mjs";

const DEFAULT_POLICY = {
  version: 1,
  codex_model: null,
  grok_model: null,
  codex_effort: null,
  grok_effort: null,
  default_mode: "review", // review | deliberate
  base: null,
  scope: "auto",
  focus: "",
  require_consensus_for: [],
  skip_paths: [],
  max_turns_r1: 40,
  max_turns_r2: 25,
  deliberate_peer: true
};

/**
 * Minimal YAML subset parser for our policy keys.
 * Supports: key: value, key: | multiline, key: with [a, b], and - list items.
 */
export function parseSimpleYaml(text) {
  const lines = String(text).split(/\r?\n/);
  const obj = {};
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith("#")) {
      i += 1;
      continue;
    }

    const m = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!m) {
      i += 1;
      continue;
    }
    const key = m[1];
    let val = m[2];

    if (val === "|" || val === ">") {
      const block = [];
      i += 1;
      while (i < lines.length) {
        const l = lines[i];
        if (l === "" || /^\s/.test(l) || l.startsWith("  ")) {
          block.push(l.replace(/^\s{2}/, ""));
          i += 1;
          continue;
        }
        if (/^[A-Za-z0-9_]+:/.test(l) || l.trim().startsWith("- ")) break;
        break;
      }
      obj[key] = block.join("\n").trim();
      continue;
    }

    if (val === "" || val === null) {
      // possible list follows
      const list = [];
      let j = i + 1;
      while (j < lines.length) {
        const l = lines[j];
        const lm = l.match(/^\s*-\s+(.*)$/);
        if (!lm) break;
        list.push(stripQuotes(lm[1].trim()));
        j += 1;
      }
      if (list.length) {
        obj[key] = list;
        i = j;
        continue;
      }
      obj[key] = "";
      i += 1;
      continue;
    }

    // inline list [a, b]
    if (val.startsWith("[") && val.endsWith("]")) {
      obj[key] = val
        .slice(1, -1)
        .split(",")
        .map((s) => stripQuotes(s.trim()))
        .filter(Boolean);
      i += 1;
      continue;
    }

    obj[key] = coerceScalar(stripQuotes(val.trim()));
    i += 1;
  }

  return obj;
}

function stripQuotes(s) {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function coerceScalar(s) {
  if (s === "true") return true;
  if (s === "false") return false;
  if (s === "null") return null;
  if (/^-?\d+$/.test(s)) return Number(s);
  return s;
}

export function loadPolicy(cwd) {
  const root = workspaceRoot(cwd);
  const candidates = [
    path.join(root, ".council.yml"),
    path.join(root, ".council.yaml"),
    path.join(root, ".council.json"),
    path.join(root, ".claude", "council.yml"),
    path.join(root, ".claude", "council.json")
  ];

  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, "utf8");
    let parsed;
    if (file.endsWith(".json")) {
      parsed = JSON.parse(text);
    } else {
      parsed = parseSimpleYaml(text);
    }
    return {
      ...DEFAULT_POLICY,
      ...parsed,
      _source: file,
      _root: root
    };
  }

  return { ...DEFAULT_POLICY, _source: null, _root: root };
}

export function mergeOptionsWithPolicy(options, policy) {
  return {
    ...options,
    adversarial: Boolean(options.adversarial),
    deliberate: Boolean(options.deliberate),
    skipCodex: Boolean(options.skipCodex),
    skipGrok: Boolean(options.skipGrok),
    claudeFindingsPath: options.claudeFindingsPath ?? null,
    base: options.base ?? policy.base ?? undefined,
    scope: options.scope ?? policy.scope ?? "auto",
    codexModel: options.codexModel ?? options["codex-model"] ?? policy.codex_model ?? options.model,
    grokModel: options.grokModel ?? options["grok-model"] ?? policy.grok_model ?? options.model,
    codexEffort: options.codexEffort ?? options["codex-effort"] ?? policy.codex_effort,
    grokEffort: options.grokEffort ?? options["grok-effort"] ?? policy.grok_effort,
    focusText:
      (options.focusText && String(options.focusText).trim()) ||
      (policy.focus ? String(policy.focus).trim() : ""),
    maxTurnsR1: options.maxTurnsR1 ?? policy.max_turns_r1 ?? 40,
    maxTurnsR2: options.maxTurnsR2 ?? policy.max_turns_r2 ?? 25,
    deliberatePeer: options.deliberatePeer ?? policy.deliberate_peer !== false,
    requireConsensusFor: policy.require_consensus_for ?? [],
    skipPaths: policy.skip_paths ?? [],
    policySource: policy._source
  };
}
