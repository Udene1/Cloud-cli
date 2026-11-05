import { NextRequest, NextResponse } from "next/server";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import { getWorkspaceSandbox, assertSafePath, workspacePath, WORKSPACE_ROOT, MAX_TEXT_FILE } from "@/lib/workspace";

export const runtime = "nodejs";
export const maxDuration = 60;

const PROTOCOL_VERSION = "2025-03-26";
const MAX_COMMAND = 3000;
const MAX_OUTPUT = 24000;

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
function clip(value: string) {
  return value.length > MAX_OUTPUT ? value.slice(0, MAX_OUTPUT) + "\n… output truncated …" : value;
}

const TOOLS = [
  { name: "workspace_list", description: "List files and directories inside the persistent CloudCLI workspace.", inputSchema: { type: "object", properties: { path: { type: "string", description: "Workspace-relative path; defaults to the workspace root." } }, additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: "workspace_read", description: "Read a UTF-8 text file in the persistent CloudCLI workspace (maximum 512 KB).", inputSchema: { type: "object", properties: { path: { type: "string", description: "Workspace-relative file path." } }, required: ["path"], additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: "workspace_write", description: "Create or replace a UTF-8 text file in the persistent CloudCLI workspace (maximum 512 KB).", inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"], additionalProperties: false }, annotations: { destructiveHint: true } },
  { name: "workspace_mkdir", description: "Create a directory inside the persistent CloudCLI workspace.", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false }, annotations: { destructiveHint: false } },
  { name: "terminal_execute", description: "Execute a shell command in the persistent CloudCLI sandbox. The working directory must remain inside the workspace. Commands can change or delete workspace data.", inputSchema: { type: "object", properties: { command: { type: "string", maxLength: MAX_COMMAND }, cwd: { type: "string", description: "Workspace-relative working directory; defaults to the workspace root." } }, required: ["command"], additionalProperties: false }, annotations: { destructiveHint: true } }
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
      const wrapped = "cd " + JSON.stringify(cwd) + " || exit 1\n" + command + "\n__cloudcli_exit=$?\nprintf '\\n__CLOUDCLI_CWD__%s' \"$PWD\"\nexit \"$__cloudcli_exit\"";
      const result = await sandbox.runCommand({ cmd: "bash", args: ["-c", wrapped], cwd: "/" });
      const raw = await result.stdout();
      const marker = "\n__CLOUDCLI_CWD__";
      const index = raw.lastIndexOf(marker);
      return textResult({ ok: result.exitCode === 0, exitCode: result.exitCode, cwd: index >= 0 ? raw.slice(index + marker.length).trim() : cwd, stdout: clip(index >= 0 ? raw.slice(0, index) : raw), stderr: clip(await result.stderr()) }, result.exitCode !== 0);
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
      instructions: "CloudCLI is an execution environment. The connected model supplies reasoning; CloudCLI supplies workspace and terminal tools. All paths are confined to the persistent workspace."
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
