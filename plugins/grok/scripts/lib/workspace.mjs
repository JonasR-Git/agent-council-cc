import { runCommandChecked } from "./process.mjs";

export function resolveWorkspaceRoot(cwd = process.cwd()) {
  try {
    return runCommandChecked("git", ["rev-parse", "--show-toplevel"], { cwd }).stdout.trim();
  } catch {
    return cwd;
  }
}
