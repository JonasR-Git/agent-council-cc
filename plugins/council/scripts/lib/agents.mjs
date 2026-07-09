import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { findGrokBinary } from "./discover.mjs";
import { runCommandAsync } from "./process.mjs";

export const READONLY_DISALLOWED_TOOLS =
  "search_replace,Write,Edit,NotebookEdit,image_gen,image_edit,image_to_video,reference_to_video,Bash,BashOutput,KillShell,run_command,run_terminal_cmd,execute_command,shell,terminal";

const PROMPTS_DIR = path.resolve(fileURLToPath(new URL("../../prompts", import.meta.url)));

export function loadPrompt(name) {
  return fs.readFileSync(path.join(PROMPTS_DIR, `${name}.md`), "utf8");
}

export function interpolate(template, values) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) =>
    values[key] != null ? String(values[key]) : ""
  );
}

export function writeTempPrompt(content) {
  const file = path.join(os.tmpdir(), `council-prompt-${Date.now()}-${Math.random().toString(16).slice(2)}.md`);
  fs.writeFileSync(file, content, "utf8");
  return file;
}

export async function waitForFile(waitPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  // Return only once the file size is non-zero and stable across two polls —
  // the writer may still be mid-write when the file first appears.
  let lastSize = -1;
  while (Date.now() <= deadline) {
    if (fs.existsSync(waitPath)) {
      try {
        const size = fs.statSync(waitPath).size;
        if (size > 0 && size === lastSize) {
          return waitPath;
        }
        lastSize = size;
      } catch {
        lastSize = -1;
      }
    }
    await delay(2000);
  }
  return fs.existsSync(waitPath) ? waitPath : null;
}

/**
 * Run Grok headless with a full prompt (structured output expected).
 */
export async function runGrokStructured(cwd, backends, options, prompt) {
  const bin = backends.grok?.bin || findGrokBinary();
  const promptFile = writeTempPrompt(prompt);
  const baseArgs = [
    "--prompt-file",
    promptFile,
    "--cwd",
    cwd,
    "--always-approve",
    "--disallowed-tools",
    READONLY_DISALLOWED_TOOLS,
    "--max-turns",
    String(options.maxTurns ?? 40),
    "--output-format",
    "plain"
  ];
  const args = [...baseArgs];
  const hasOverrides = Boolean(options.grokModel || options.grokEffort);
  if (options.grokModel) args.push("--model", options.grokModel);
  if (options.grokEffort) args.push("--effort", options.grokEffort);

  try {
    let result = await runCommandAsync(bin, args, { cwd, timeoutMs: options.agentTimeoutMs });
    let retriedWithoutOverrides = false;
    // Valid model/effort ids depend on the CLI login (e.g. "grok models" may not
    // list a configured id at all). Rather than failing the whole round, retry
    // once with the CLI's own defaults.
    if (
      hasOverrides &&
      result.status !== 0 &&
      !result.timedOut &&
      /invalid params|unknown model/i.test(`${result.stderr}\n${result.stdout}`)
    ) {
      result = await runCommandAsync(bin, baseArgs, { cwd, timeoutMs: options.agentTimeoutMs });
      retriedWithoutOverrides = true;
    }
    return {
      agent: "grok",
      backend: retriedWithoutOverrides ? "grok-cli (model/effort overrides rejected, CLI defaults used)" : "grok-cli",
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: Boolean(result.timedOut),
      truncated: Boolean(result.truncated),
      model: retriedWithoutOverrides ? "(CLI default after rejected override)" : options.grokModel ?? "(default)",
      command: `${bin} --prompt-file ...`
    };
  } finally {
    try {
      fs.unlinkSync(promptFile);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Run Codex via companion task (read-only-ish prompt for structured output).
 * Falls back to adversarial-review with focus embedding the prompt snippet.
 */
export async function runCodexStructured(cwd, backends, options, prompt, label) {
  if (!backends.codex?.companionAvailable) {
    return {
      agent: "codex",
      skipped: true,
      reason: "codex companion not found",
      stdout: "",
      stderr: ""
    };
  }

  const companion = backends.codex.companion;
  const promptFile = writeTempPrompt(prompt);
  const args = [companion, "task", "--prompt-file", promptFile];
  if (options.codexModel) args.push("--model", options.codexModel);

  try {
    const result = await runCommandAsync(process.execPath, args, {
      cwd,
      timeoutMs: options.agentTimeoutMs
    });
    // The adversarial-review fallback only carries a short focus string, never
    // the structured prompt — it can only stand in for a plain R1 review.
    // R2/debate/solve calls must fail visibly instead of degrading silently.
    const fallbackAllowed = String(label ?? "") === "r1";
    if (result.status !== 0 && !result.timedOut && !result.stdout?.trim() && fallbackAllowed) {
      const focus = `Return ONLY JSON findings. Context label: ${label}. Follow structured review schema with agent=codex.`;
      const fallbackArgs = [companion, "adversarial-review"];
      if (options.base) fallbackArgs.push("--base", options.base);
      if (options.scope) fallbackArgs.push("--scope", options.scope);
      if (options.codexModel) fallbackArgs.push("--model", options.codexModel);
      fallbackArgs.push(focus);
      const fb = await runCommandAsync(process.execPath, fallbackArgs, {
        cwd,
        timeoutMs: options.agentTimeoutMs
      });
      return {
        agent: "codex",
        backend: "codex-companion-adversarial-fallback",
        status: fb.status,
        stdout: fb.stdout,
        stderr: fb.stderr,
        timedOut: Boolean(fb.timedOut),
        truncated: Boolean(fb.truncated),
        model: options.codexModel ?? "(default)",
        command: `node ... adversarial-review`
      };
    }
    return {
      agent: "codex",
      backend: "codex-companion-task",
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: Boolean(result.timedOut),
      truncated: Boolean(result.truncated),
      model: options.codexModel ?? "(default)",
      command: `node ... task --prompt-file`
    };
  } finally {
    try {
      fs.unlinkSync(promptFile);
    } catch {
      /* ignore */
    }
  }
}
