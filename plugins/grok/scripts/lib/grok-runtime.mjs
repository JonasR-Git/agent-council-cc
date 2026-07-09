import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { binaryAvailable, runCommand } from "./process.mjs";

const READONLY_DISALLOWED_TOOLS =
  "search_replace,Write,Edit,NotebookEdit,image_gen,image_edit,image_to_video,reference_to_video,Bash,BashOutput,KillShell,run_command,run_terminal_cmd,execute_command,shell,terminal";
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

function resolveGrokBinary() {
  const fromEnv = process.env.GROK_BIN || process.env.GROK_PATH;
  if (fromEnv && fs.existsSync(fromEnv)) {
    return fromEnv;
  }

  const home = os.homedir();
  const candidates = [
    path.join(home, ".grok", "bin", process.platform === "win32" ? "grok.exe" : "grok"),
    path.join(home, ".local", "bin", "grok")
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return "grok";
}

export function getGrokAvailability(cwd) {
  const bin = resolveGrokBinary();
  const status = binaryAvailable(bin, ["--version"], { cwd });
  return {
    ...status,
    bin
  };
}

export function getGrokAuthHint(cwd) {
  const authFile = path.join(os.homedir(), ".grok", "auth.json");
  const hasAuthFile = fs.existsSync(authFile);
  if (!hasAuthFile) {
    return {
      loggedIn: false,
      detail: "No ~/.grok/auth.json found. Run `grok login`."
    };
  }
  return {
    loggedIn: true,
    detail: "auth.json present (session validity not fully verified non-interactively)."
  };
}

export function runGrokPrompt(cwd, options = {}) {
  const bin = resolveGrokBinary();
  const prompt = options.prompt ?? "";
  if (!prompt.trim()) {
    throw new Error("Empty prompt for Grok.");
  }

  const promptFile = options.promptFile ?? path.join(os.tmpdir(), `grok-prompt-${Date.now()}.md`);
  fs.writeFileSync(promptFile, prompt, "utf8");

  const args = [
    "--prompt-file",
    promptFile,
    "--cwd",
    cwd,
    "--output-format",
    options.outputFormat ?? "plain",
    "--max-turns",
    String(options.maxTurns ?? 40)
  ];

  if (options.model) {
    args.push("--model", options.model);
  }
  if (options.effort) {
    args.push("--effort", options.effort);
  }
  if (options.readOnly) {
    args.push("--disallowed-tools", READONLY_DISALLOWED_TOOLS);
  }
  if (options.alwaysApprove || options.write) {
    args.push("--always-approve");
  }
  if (options.resumeSessionId) {
    args.push("--resume", options.resumeSessionId);
  }

  const started = Date.now();
  const result = runCommand(bin, args, {
    cwd,
    env: process.env,
    timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  });

  try {
    fs.unlinkSync(promptFile);
  } catch {
    /* ignore */
  }

  return {
    status: result.status === 0 ? 0 : result.status || 1,
    stdout: result.stdout,
    stderr: result.stderr,
    durationMs: Date.now() - started,
    bin,
    args
  };
}
