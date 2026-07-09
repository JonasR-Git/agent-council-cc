import { spawnSync } from "node:child_process";
import process from "node:process";

export function runCommand(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    maxBuffer: options.maxBuffer ?? 20 * 1024 * 1024,
    stdio: options.stdio ?? "pipe",
    shell: process.platform === "win32" ? true : false,
    windowsHide: true,
    timeout: options.timeout
  });

  return {
    command,
    args,
    status: result.status ?? (result.error ? 1 : 0),
    signal: result.signal ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ?? null
  };
}

export function runCommandChecked(command, args = [], options = {}) {
  const result = runCommand(command, args, options);
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return result;
}

export function formatCommandFailure(result) {
  const detail = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
  return `${result.command} ${(result.args ?? []).join(" ")} failed (exit ${result.status})${detail ? `:\n${detail}` : ""}`;
}

export function binaryAvailable(command, versionArgs = ["--version"], options = {}) {
  const result = runCommand(command, versionArgs, options);
  if (result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOENT") {
    return { available: false, detail: "not found" };
  }
  if (result.error) {
    return { available: false, detail: result.error.message };
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
    return { available: false, detail };
  }
  return { available: true, detail: result.stdout.trim() || result.stderr.trim() || "ok" };
}

export function terminateProcessTree(pid) {
  if (!Number.isFinite(pid)) {
    return { attempted: false, delivered: false };
  }

  if (process.platform === "win32") {
    const result = runCommand("taskkill", ["/PID", String(pid), "/T", "/F"]);
    return {
      attempted: true,
      delivered: !result.error && result.status === 0,
      method: "taskkill"
    };
  }

  try {
    process.kill(-pid, "SIGTERM");
    return { attempted: true, delivered: true, method: "kill-group" };
  } catch {
    try {
      process.kill(pid, "SIGTERM");
      return { attempted: true, delivered: true, method: "kill" };
    } catch {
      return { attempted: true, delivered: false, method: "kill" };
    }
  }
}
