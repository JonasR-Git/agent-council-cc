import { spawn, spawnSync } from "node:child_process";
import process from "node:process";

const DEFAULT_MAX_BUFFER = 20 * 1024 * 1024;

export function needsCmdShell(command) {
  if (process.platform !== "win32") {
    return false;
  }
  const text = String(command ?? "");
  return /\.(?:cmd|bat)$/i.test(text) || !/[\\/]/.test(text);
}

export function quoteForCmd(token) {
  const text = String(token ?? "");
  if (/^[A-Za-z0-9_\-.:\\/=]+$/.test(text)) {
    return text;
  }
  return `"${text.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, "$1$1")}"`;
}

function prepareSpawn(command, args = []) {
  if (!needsCmdShell(command)) {
    return { command, args, shell: false };
  }
  return {
    command: [command, ...args].map(quoteForCmd).join(" "),
    args: [],
    shell: true
  };
}

export function runCommand(command, args = [], options = {}) {
  const prepared = prepareSpawn(command, args);
  const result = spawnSync(prepared.command, prepared.args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
    stdio: options.stdio ?? "pipe",
    shell: prepared.shell,
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

export function formatCommandFailure(result) {
  const detail = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
  return `${result.command} ${(result.args ?? []).join(" ")} failed (exit ${result.status})${detail ? `:\n${detail}` : ""}`;
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

export function runCommandAsync(command, args = [], options = {}) {
  return new Promise((resolve) => {
    const prepared = prepareSpawn(command, args);
    // On POSIX a tree-kill needs a process group leader: detach by default
    // whenever a timeout may have to kill the child's whole tree.
    const detached =
      options.detached ??
      (process.platform !== "win32" && options.timeoutMs != null && Number(options.timeoutMs) > 0);
    let child;
    try {
      child = spawn(prepared.command, prepared.args, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        shell: prepared.shell,
        windowsHide: true,
        detached: Boolean(detached),
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (error) {
      resolve({
        command,
        args,
        status: 1,
        signal: null,
        stdout: "",
        stderr: "",
        error,
        pid: null,
        timedOut: false,
        truncated: false
      });
      return;
    }

    const maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;
    let stdout = "";
    let stderr = "";
    let capturedBytes = 0;
    let settled = false;
    let timedOut = false;
    let truncated = false;
    let timeoutId = null;

    function append(stream, chunk) {
      if (truncated || settled) {
        return;
      }
      const text = chunk.toString();
      const remaining = maxBuffer - capturedBytes;
      const bytes = Buffer.byteLength(text);
      if (bytes <= remaining) {
        if (stream === "stdout") stdout += text;
        else stderr += text;
        capturedBytes += bytes;
        return;
      }

      if (remaining > 0) {
        let used = 0;
        let clipped = "";
        for (const ch of text) {
          const size = Buffer.byteLength(ch);
          if (used + size > remaining) break;
          clipped += ch;
          used += size;
        }
        if (stream === "stdout") stdout += clipped;
        else stderr += clipped;
        capturedBytes += used;
      }
      truncated = true;
      terminateProcessTree(child.pid);
    }

    function finish(payload) {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      resolve({
        command,
        args,
        stdout,
        stderr,
        error: null,
        pid: child.pid ?? null,
        timedOut,
        truncated,
        ...payload
      });
    }

    if (options.timeoutMs != null && Number(options.timeoutMs) > 0) {
      timeoutId = setTimeout(() => {
        timedOut = true;
        terminateProcessTree(child.pid);
        stderr += `${stderr ? "\n" : ""}[timed out after ${options.timeoutMs}ms]`;
        finish({ status: 124, signal: null });
      }, Number(options.timeoutMs));
      timeoutId.unref?.();
    }

    child.stdout?.on("data", (chunk) => append("stdout", chunk));
    child.stderr?.on("data", (chunk) => append("stderr", chunk));
    child.on("error", (error) => {
      finish({ status: 1, signal: null, error });
    });
    child.on("close", (code, signal) => {
      finish({ status: code ?? 1, signal });
    });
  });
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
