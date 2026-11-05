import { NextRequest, NextResponse } from "next/server";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import { getWorkspaceSandbox, assertSafePath, workspacePath, WORKSPACE_ROOT, MAX_TEXT_FILE } from "@/lib/workspace";

export const runtime = "nodejs";
export const maxDuration = 60;

const PROTOCOL_VERSION = "2025-03-26";
const MAX_COMMAND = 3000;
const MAX_OUTPUT = 24000;
const REPO_ROOT = path.join(WORKSPACE_ROOT, "repositories");

type JsonRpcRequest = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };
type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function authorized(request: NextRequest) {
  const expected = process.env.CLOUDCLI_MCP_TOKEN;
  const header = request.headers.get("authorization") || "";
  const supplied = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!expected || expected.length < 32 || !supplied) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(supplied);
  return a.length === b.length && timingSafeEqual(a, b);
}

function rpc(id: JsonRpcRequest["id"], result: unknown) {
  return NextResponse.json({ jsonrpc: "2.0", id: id ?? null, result }, {
    headers: { "MCP-Protocol-Version": PROTOCOL_VERSION, "Cache-Control": "no-store" }
  });
}
function rpcError(id: JsonRpcRequest["id"], code: number, message: string) {
  return NextResponse.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }, {
    status: 200,
    headers: { "MCP-Protocol-Version": PROTOCOL_VERSION, "Cache-Control": "no-store" }
  });
}
function textResult(value: unknown, isError = false): ToolResult {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text", text: text.slice(0, MAX_OUTPUT) }], ...(isError ? { isError: true } : {}) };
}
function objectArg(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Tool arguments must be an object.");
  return value as Record<string, unknown>;
}
function stringArg(args: Record<string, unknown>, key: string, max = 1000) {
  const value = args[key];
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) {
    throw new Error(key + " must be a non-empty string (maximum " + max + " characters).");
  }
  return value;
}
function safeRepo(value: unknown) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) throw new Error("repository must be owner/name.");
  return value;
}
function safeBranch(value: unknown) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(value) || value.includes("..") || value.endsWith("/") || value.endsWith(".lock")) throw new Error("Invalid branch name.");
  return value;
}
function safeMessage(value: unknown) {
  if (typeof value !== "string" || !value.trim() || value.length > 200) throw new Error("Enter a message (maximum 200 characters).");
  return value.trim();
}
async function run(sandbox: Awaited<ReturnType<typeof getWorkspaceSandbox>>, cmd: string, args: string[] = [], cwd = WORKSPACE_ROOT) {
  const result = await sandbox.runCommand({ cmd, args, cwd });
  return { stdout: await result.stdout(), stderr: await result.stderr(), exitCode: result.exitCode };
}
function clip(value: string) {
  return value.length > MAX_OUTPUT ? value.slice(0, MAX_OUTPUT) + "\n… output truncated …" : value;
}

const TOOLS = [
  { name: "workspace_list", description: "List files and directories inside the persistent CloudCLI workspace.", inputSchema: { type: "object", properties: { path: { type: "string", description: "Workspace-relative path; defaults to the workspace root." } }, additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: "workspace_read", description: "Read a UTF-8 text file in the persistent CloudCLI workspace (maximum 512 KB).", inputSchema: { type: "object", properties: { path: { type: "string", description: "Workspace-relative file path." } }, required: ["path"], additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: "workspace_write", description: "Create or replace a UTF-8 text file in the persistent CloudCLI workspace (maximum 512 KB).", inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"], additionalProperties: false }, annotations: { destructiveHint: true } },
  { name: "workspace_mkdir", description: "Create a directory inside the persistent CloudCLI workspace.", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false }, annotations: { destructiveHint: false } },
  { name: "terminal_execute", description: "Execute a shell command in the persistent CloudCLI sandbox. The working directory must remain inside the workspace. Commands can change or delete workspace data.", inputSchema: { type: "object", properties: { command: { type: "string", maxLength: MAX_COMMAND }, cwd: { type: "string", description: "Workspace-relative working directory; defaults to the workspace root." } }, required: ["command"], additionalProperties: false }, annotations: { destructiveHint: true } },
  { name: "github_connection", description: "Check whether GitHub CLI is installed and authenticated in the CloudCLI workspace.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: "github_list_repositories", description: "List repositories available to the connected GitHub account (up to 50).", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: "github_clone_repository", description: "Clone an accessible GitHub repository into the CloudCLI workspace under repositories/owner/name.", inputSchema: { type: "object", properties: { repository: { type: "string", description: "GitHub owner/repository." } }, required: ["repository"], additionalProperties: false }, annotations: { destructiveHint: true } },
  { name: "github_repository_status", description: "Inspect branch, working-tree status, remotes, recent commits and local branches for a cloned repository.", inputSchema: { type: "object", properties: { path: { type: "string", description: "Workspace-relative path to the cloned repository." } }, required: ["path"], additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: "github_create_branch", description: "Create and switch to a new branch in a cloned repository.", inputSchema: { type: "object", properties: { path: { type: "string" }, branch: { type: "string" } }, required: ["path", "branch"], additionalProperties: false }, annotations: { destructiveHint: true } },
  { name: "github_switch_branch", description: "Switch to an existing local branch in a cloned repository.", inputSchema: { type: "object", properties: { path: { type: "string" }, branch: { type: "string" } }, required: ["path", "branch"], additionalProperties: false }, annotations: { destructiveHint: true } },
  { name: "github_pull", description: "Fast-forward pull the current branch from its upstream remote.", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false }, annotations: { destructiveHint: true } },
  { name: "github_list_pull_requests", description: "List open pull requests for a cloned repository.", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: "github_commit", description: "Stage and commit repository changes. Common secret files are blocked; inspect the diff before pushing.", inputSchema: { type: "object", properties: { path: { type: "string" }, message: { type: "string", maxLength: 200 } }, required: ["path", "message"], additionalProperties: false }, annotations: { destructiveHint: true } },
  { name: "github_push", description: "Push the current branch to its origin remote. This publishes committed changes to GitHub.", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false }, annotations: { destructiveHint: true } },
  { name: "github_create_pull_request", description: "Create a pull request from the current branch using GitHub CLI.", inputSchema: { type: "object", properties: { path: { type: "string" }, title: { type: "string", maxLength: 200 }, body: { type: "string", maxLength: 5000 } }, required: ["path", "title"], additionalProperties: false }, annotations: { destructiveHint: true } }
] as const;

async function callTool(name: string, rawArgs: unknown): Promise<ToolResult> {
  const args = objectArg(rawArgs);
  let sandbox: Awaited<ReturnType<typeof getWorkspaceSandbox>> | undefined;
  try {
    sandbox = await getWorkspaceSandbox();
    if (name === "workspace_list") {
      const target = workspacePath(typeof args.path === "string" ? args.path : ".");
      await assertSafePath(sandbox, target);
      const stat = await sandbox.fs.stat(target);
      if (!stat.isDirectory()) throw new Error("Path is not a directory.");
      const entries = await sandbox.fs.readdir(target, { withFileTypes: true });
      const items = await Promise.all(entries.map(async (entry: any) => {
        const fullPath = path.join(target, entry.name);
        const info = await sandbox!.fs.lstat(fullPath);
        return { name: entry.name, path: path.relative(WORKSPACE_ROOT, fullPath), kind: info.isSymbolicLink() ? "link" : info.isDirectory() ? "directory" : "file", size: info.size || 0 };
      }));
      items.sort((a, b) => a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "directory" ? -1 : 1);
      return textResult({ path: path.relative(WORKSPACE_ROOT, target) || ".", items });
    }
    if (name === "workspace_read") {
      const target = workspacePath(stringArg(args, "path"));
      await assertSafePath(sandbox, target);
      const stat = await sandbox.fs.stat(target);
      if (!stat.isFile()) throw new Error("Path is not a file.");
      if (stat.size > MAX_TEXT_FILE) throw new Error("File exceeds the 512 KB text-read limit.");
      return textResult({ path: path.relative(WORKSPACE_ROOT, target), content: await sandbox.fs.readFile(target, "utf8") });
    }
    if (name === "workspace_write") {
      const target = workspacePath(stringArg(args, "path"));
      const content = typeof args.content === "string" ? args.content : null;
      if (content === null) throw new Error("content must be a string.");
      if (Buffer.byteLength(content, "utf8") > MAX_TEXT_FILE) throw new Error("Text files are limited to 512 KB.");
      await assertSafePath(sandbox, path.dirname(target));
      await assertSafePath(sandbox, target, true);
      await sandbox.fs.writeFile(target, content, "utf8");
      return textResult({ ok: true, path: path.relative(WORKSPACE_ROOT, target), bytes: Buffer.byteLength(content, "utf8") });
    }
    if (name === "workspace_mkdir") {
      const target = workspacePath(stringArg(args, "path"));
      await assertSafePath(sandbox, path.dirname(target));
      await assertSafePath(sandbox, target, true);
      await sandbox.fs.mkdir(target);
      return textResult({ ok: true, path: path.relative(WORKSPACE_ROOT, target) });
    }
    if (name === "terminal_execute") {
      const command = stringArg(args, "command", MAX_COMMAND);
      const cwd = workspacePath(typeof args.cwd === "string" && args.cwd.trim() ? args.cwd : ".");
      await assertSafePath(sandbox, cwd);
      const stat = await sandbox.fs.stat(cwd);
      if (!stat.isDirectory()) throw new Error("Working directory must be a directory.");
      const wrapped = 'cd -- "$1" || exit 1\n' + command + '\n__cloudcli_exit=$?\nprintf \'\\n__CLOUDCLI_CWD__%s\' "$PWD"\nexit "$__cloudcli_exit"';
      const result = await sandbox.runCommand({ cmd: "bash", args: ["-c", wrapped, "cloudcli", cwd], cwd: "/" });
      const raw = await result.stdout();
      const marker = "\n__CLOUDCLI_CWD__";
      const index = raw.lastIndexOf(marker);
      return textResult({ ok: result.exitCode === 0, exitCode: result.exitCode, cwd: index >= 0 ? raw.slice(index + marker.length).trim() : cwd, stdout: clip(index >= 0 ? raw.slice(0, index) : raw), stderr: clip(await result.stderr()) }, result.exitCode !== 0);
    }
    if (name.startsWith("github_")) {
      const auth = await run(sandbox, "gh", ["auth", "status"]);
      if (auth.exitCode !== 0) {
        const installed = await run(sandbox, "bash", ["-lc", "command -v gh >/dev/null 2>&1"]);
        throw new Error(installed.exitCode === 0
          ? "GitHub CLI is installed but not authenticated. Connect GitHub in the CloudCLI GitHub tab first."
          : "GitHub CLI is not installed in this workspace. Install gh and connect GitHub in the CloudCLI GitHub tab first.");
      }
      await run(sandbox, "gh", ["auth", "setup-git"]);
      if (name === "github_connection") {
        const identity = await run(sandbox, "gh", ["api", "user", "--jq", ".login"]);
        return textResult({ connected: identity.exitCode === 0, login: identity.stdout.trim() });
      }
      if (name === "github_list_repositories") {
        const result = await run(sandbox, "gh", ["repo", "list", "--json", "nameWithOwner,description,isPrivate,updatedAt", "--limit", "50"]);
        if (result.exitCode !== 0) throw new Error(result.stderr || "Could not list repositories.");
        return textResult(JSON.parse(result.stdout));
      }
      if (name === "github_clone_repository") {
        const repository = safeRepo(stringArg(args, "repository", 200));
        const [owner, slug] = repository.split("/");
        const parent = path.join(REPO_ROOT, owner);
        const target = path.join(parent, slug);
        await sandbox.runCommand({ cmd: "mkdir", args: ["-p", parent], cwd: WORKSPACE_ROOT });
        await assertSafePath(sandbox, parent);
        if (await sandbox.fs.stat(target).then(() => true).catch(() => false)) throw new Error("Repository folder already exists: " + path.relative(WORKSPACE_ROOT, target));
        const result = await run(sandbox, "gh", ["repo", "clone", repository, target], WORKSPACE_ROOT);
        if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout || "Clone failed.");
        const identity = await run(sandbox, "gh", ["api", "user", "--jq", ".login + \"|\" + (.id|tostring)"]);
        const [login, id] = identity.stdout.trim().split("|");
        if (identity.exitCode === 0 && login && Number.isSafeInteger(Number(id)) && Number(id) > 0) {
          await run(sandbox, "git", ["config", "user.name", login], target);
          await run(sandbox, "git", ["config", "user.email", id + "+" + login + "@users.noreply.github.com"], target);
        }
        return textResult({ ok: true, path: path.relative(WORKSPACE_ROOT, target), output: result.stdout || "Repository cloned." });
      }
      const directory = workspacePath(stringArg(args, "path", 1000));
      if (directory === WORKSPACE_ROOT) throw new Error("Select a cloned repository folder.");
      await assertSafePath(sandbox, directory);
      const dirStat = await sandbox.fs.stat(directory);
      if (!dirStat.isDirectory()) throw new Error("Repository path must be a directory.");
      const gitCheck = await run(sandbox, "git", ["rev-parse", "--is-inside-work-tree"], directory);
      if (gitCheck.exitCode !== 0 || gitCheck.stdout.trim() !== "true") throw new Error("That folder is not a Git repository.");
      if (name === "github_repository_status") {
        const [branch, status, remote, log, branches] = await Promise.all([
          run(sandbox, "git", ["branch", "--show-current"], directory),
          run(sandbox, "git", ["status", "--short", "--branch"], directory),
          run(sandbox, "git", ["remote", "-v"], directory),
          run(sandbox, "git", ["log", "-6", "--oneline", "--decorate"], directory),
          run(sandbox, "git", ["branch", "--all", "--no-color"], directory)
        ]);
        return textResult({ path: path.relative(WORKSPACE_ROOT, directory), branch: branch.stdout.trim(), status: status.stdout, remotes: remote.stdout, recentCommits: log.stdout, branches: branches.stdout.split("\n").map(x => x.trim()).filter(Boolean) });
      }
      if (name === "github_create_branch") {
        const branchName = safeBranch(stringArg(args, "branch", 100));
        const result = await run(sandbox, "git", ["switch", "-c", branchName], directory);
        if (result.exitCode !== 0) throw new Error(result.stderr || "Could not create branch.");
        return textResult({ ok: true, branch: branchName, output: result.stdout });
      }
      if (name === "github_switch_branch") {
        const branchName = safeBranch(stringArg(args, "branch", 100));
        const result = await run(sandbox, "git", ["switch", branchName], directory);
        if (result.exitCode !== 0) throw new Error(result.stderr || "Could not switch branch.");
        return textResult({ ok: true, branch: branchName, output: result.stdout });
      }
      if (name === "github_pull") {
        const result = await run(sandbox, "git", ["pull", "--ff-only"], directory);
        if (result.exitCode !== 0) throw new Error(result.stderr || "Fast-forward pull failed.");
        return textResult({ ok: true, output: result.stdout || "Already up to date." });
      }
      if (name === "github_list_pull_requests") {
        const result = await run(sandbox, "gh", ["pr", "list", "--state", "open", "--json", "number,title,url,headRefName,baseRefName,author", "--limit", "50"], directory);
        if (result.exitCode !== 0) throw new Error(result.stderr || "Could not list pull requests.");
        return textResult(JSON.parse(result.stdout));
      }
      if (name === "github_commit") {
        const message = safeMessage(args.message);
        const add = await run(sandbox, "git", ["add", "-A"], directory);
        if (add.exitCode !== 0) throw new Error(add.stderr || "Could not stage changes.");
        const staged = await run(sandbox, "git", ["diff", "--cached", "--name-only"], directory);
        const risky = staged.stdout.split("\n").filter(file => /(^|\/)\.env($|\.(?!example$))|\.(pem|key)$|(^|\/)(id_rsa|credentials\.json|secrets?\.[^/]+)$/i.test(file));
        if (risky.length) {
          await run(sandbox, "git", ["reset", "-q", "--", ...risky], directory);
          throw new Error("Commit blocked: sensitive-looking files were excluded from staging: " + risky.join(", "));
        }
        const result = await run(sandbox, "git", ["commit", "-m", message], directory);
        if (result.exitCode !== 0) throw new Error(result.stderr || "Commit failed; check whether there are changes to commit.");
        return textResult({ ok: true, output: result.stdout });
      }
      if (name === "github_push") {
        const result = await run(sandbox, "git", ["push", "-u", "origin", "HEAD"], directory);
        if (result.exitCode !== 0) throw new Error(result.stderr || "Push failed.");
        return textResult({ ok: true, output: result.stdout || "Current branch pushed." });
      }
      if (name === "github_create_pull_request") {
        const title = safeMessage(args.title);
        const body = typeof args.body === "string" ? args.body.slice(0, 5000) : "Created from CloudCLI.";
        const result = await run(sandbox, "gh", ["pr", "create", "--title", title, "--body", body], directory);
        if (result.exitCode !== 0) throw new Error(result.stderr || "Could not create pull request.");
        return textResult({ ok: true, url: result.stdout.trim() });
      }
    }
    throw new Error("Unknown tool: " + name);
  } catch (error) {
    return textResult({ error: error instanceof Error ? error.message : "CloudCLI tool failed." }, true);
  } finally {
    if (sandbox) await sandbox.stop().catch(() => undefined);
  }
}

export async function POST(request: NextRequest) {
  if (!authorized(request)) return NextResponse.json({ error: "Unauthorized. Configure CLOUDCLI_MCP_TOKEN and send it as a Bearer token." }, { status: 401 });
  let message: JsonRpcRequest;
  try { message = await request.json(); } catch { return rpcError(null, -32700, "Parse error."); }
  if (message.jsonrpc !== "2.0" || typeof message.method !== "string") return rpcError(message.id, -32600, "Invalid JSON-RPC request.");
  if (message.method === "notifications/initialized" || message.method.startsWith("notifications/")) {
    return new NextResponse(null, { status: 202, headers: { "MCP-Protocol-Version": PROTOCOL_VERSION } });
  }
  if (message.method === "initialize") {
    return rpc(message.id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: "cloudcli", version: "0.1.0" },
      instructions: "CloudCLI is an execution environment. The connected model supplies reasoning; CloudCLI supplies workspace, terminal, and GitHub tools. Workspace file operations and the initial working directory are confined to the persistent workspace. Shell commands can access other files and credentials available inside the isolated microVM; treat this server as full sandbox access."
    });
  }
  if (message.method === "ping") return rpc(message.id, {});
  if (message.method === "tools/list") return rpc(message.id, { tools: TOOLS });
  if (message.method === "tools/call") {
    const params = message.params || {};
    if (typeof params.name !== "string") return rpcError(message.id, -32602, "Tool name is required.");
    const result = await callTool(params.name, params.arguments || {});
    return rpc(message.id, result);
  }
  return rpcError(message.id, -32601, "Method not found: " + message.method);
}

export async function GET() {
  return new NextResponse("CloudCLI MCP endpoint. Use POST with the MCP Streamable HTTP transport.", {
    status: 405,
    headers: { Allow: "POST", "Content-Type": "text/plain; charset=utf-8" }
  });
}
