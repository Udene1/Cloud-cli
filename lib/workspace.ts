import path from "node:path";
import { Sandbox } from "@vercel/sandbox";

export const WORKSPACE_ROOT = "/vercel/sandbox";
export const MAX_TEXT_FILE = 512 * 1024;
export const MAX_UPLOAD = 5 * 1024 * 1024;

export function workspacePath(input: unknown) {
  if (typeof input !== "string" || input.includes("\0")) throw new Error("Invalid workspace path.");
  const resolved = path.resolve(WORKSPACE_ROOT, input || ".");
  if (resolved !== WORKSPACE_ROOT && !resolved.startsWith(WORKSPACE_ROOT + path.sep)) {
    throw new Error("Path must stay inside the workspace.");
  }
  return resolved;
}

export async function getWorkspaceSandbox() {
  const sandbox = await Sandbox.getOrCreate({
    name: "cloudcli-workspace",
    timeout: 45 * 60 * 1000,
    persistent: true,
    resources: { vcpus: 1 },
    resume: true,
  });
  await sandbox.runCommand({ cmd: "mkdir", args: ["-p", WORKSPACE_ROOT], cwd: "/" });
  return sandbox;
}

export async function assertSafePath(sandbox: Awaited<ReturnType<typeof getWorkspaceSandbox>>, target: string, allowMissing = false) {
  const root = await sandbox.fs.realpath(WORKSPACE_ROOT);
  let actual: string;
  try {
    const entry = await sandbox.fs.lstat(target);
    if (entry.isSymbolicLink()) throw new Error("Symbolic links cannot be modified through the explorer.");
    actual = await sandbox.fs.realpath(target);
  } catch (error) {
    if (!allowMissing || (error instanceof Error && error.message.includes("Symbolic links"))) throw error;
    const parent = await sandbox.fs.realpath(path.dirname(target));
    if (parent !== root && !parent.startsWith(root + path.sep)) throw new Error("Path resolves outside the workspace.");
    return;
  }
  if (actual !== root && !actual.startsWith(root + path.sep)) throw new Error("Path resolves outside the workspace.");
}
