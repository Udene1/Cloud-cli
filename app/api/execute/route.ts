import { NextRequest, NextResponse } from "next/server";
import path from "node:path";
import { Sandbox } from "@vercel/sandbox";
import { isAuthenticated } from "@/lib/auth";
export const runtime = "nodejs";
export const maxDuration = 60;
const MAX_COMMAND = 3000;
const MAX_OUTPUT = 24000;
const WORKSPACE_ROOT = "/vercel/sandbox";

function resolveWorkspaceCwd(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return WORKSPACE_ROOT;
  const resolved = path.resolve(WORKSPACE_ROOT, value);
  if (resolved !== WORKSPACE_ROOT && !resolved.startsWith(WORKSPACE_ROOT + path.sep)) {
    throw new Error("Working directory must stay inside /vercel/sandbox.");
  }
  return resolved;
}

function generatedFile(command: string): { name: string; content: string } | null | "invalid" {
  const match = command.trim().match(/^generate\s+(node|python|typescript|html|react|solidity|sql|markdown)\s+([a-zA-Z0-9._-]+)$/i);
  if (!match) return command.trim().startsWith("generate ") ? "invalid" : null;
  const kind = match[1].toLowerCase(), name = match[2];
  if (name.includes("..") || name.startsWith(".") || name.includes("/")) return "invalid";
  const templates: Record<string, string> = {
    node: '#!/usr/bin/env node\n\nasync function main() {\n  console.log("Hello from CloudCLI");\n}\n\nmain().catch((error) => {\n  console.error(error);\n  process.exitCode = 1;\n});\n',
    python: 'def main() -> None:\n    print("Hello from CloudCLI")\n\nif __name__ == "__main__":\n    main()\n',
    typescript: 'async function main(): Promise<void> {\n  console.log("Hello from CloudCLI");\n}\n\nmain().catch((error: unknown) => {\n  console.error(error);\n  process.exitCode = 1;\n});\n',
    html: '<!doctype html>\n<html lang="en">\n<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>CloudCLI page</title></head>\n<body><main><h1>Hello from CloudCLI</h1></main></body>\n</html>\n',
    react: 'import { useState } from "react";\n\nexport default function App() {\n  const [count, setCount] = useState(0);\n  return <main><h1>CloudCLI starter</h1><button onClick={() => setCount((n) => n + 1)}>Count: {count}</button></main>;\n}\n',
    solidity: '// SPDX-License-Identifier: MIT\npragma solidity ^0.8.24;\n\ncontract Counter {\n    uint256 public count;\n    event CountChanged(uint256 newCount);\n\n    function increment() external {\n        count += 1;\n        emit CountChanged(count);\n    }\n}\n',
    sql: '-- CloudCLI SQL starter\nCREATE TABLE IF NOT EXISTS items (\n  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,\n  name TEXT NOT NULL,\n  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()\n);\n',
    markdown: '# Project\n\n## Overview\n\nDescribe what this project does.\n\n## Getting started\n\nAdd setup instructions here.\n'
  };
  const extensions: Record<string, string> = { node: ".js", python: ".py", typescript: ".ts", html: ".html", react: ".jsx", solidity: ".sol", sql: ".sql", markdown: ".md" };
  return { name: name.includes(".") ? name : name + extensions[kind], content: templates[kind] };
}
function clip(text: string) {
  return text.length > MAX_OUTPUT ? text.slice(0, MAX_OUTPUT) + "\n… output truncated …" : text;
}
export async function POST(request: NextRequest) {
  if (!isAuthenticated(request)) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  let body: { command?: unknown; cwd?: unknown };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid request body." }, { status: 400 }); }
  const command = typeof body.command === "string" ? body.command.trim() : "";
  if (!command) return NextResponse.json({ error: "Enter a command." }, { status: 400 });
  if (command.length > MAX_COMMAND) return NextResponse.json({ error: "Command exceeds the 3,000 character limit." }, { status: 413 });
  if (command.includes("\0")) return NextResponse.json({ error: "Null bytes are not allowed." }, { status: 400 });
  let cwd: string;
  try { cwd = resolveWorkspaceCwd(body.cwd); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid working directory." }, { status: 400 }); }

  const generated = generatedFile(command);
  if (generated === "invalid") return NextResponse.json({ error: "Usage: generate node|python|typescript|html|react|solidity|sql|markdown <filename>" }, { status: 400 });

  let sandbox: Awaited<ReturnType<typeof Sandbox.getOrCreate>> | undefined;
  const started = Date.now();
  try {
    sandbox = await Sandbox.getOrCreate({
      name: "cloudcli-workspace", timeout: 300000, persistent: true, resources: { vcpus: 1 }
    });
    // The sandbox image does not guarantee that /vercel/sandbox exists.
    // Bootstrap the persistent workspace from the known-present filesystem root.
    const bootstrap = await sandbox.runCommand({ cmd: "bash", args: ["-lc", "mkdir -p /vercel/sandbox"], cwd: "/" });
    if (bootstrap.exitCode !== 0) {
      return NextResponse.json({ error: "Could not initialize the CloudCLI workspace: " + clip(await bootstrap.stderr()) }, { status: 500 });
    }
    if (generated) {
      await sandbox.writeFiles([{ path: path.join(cwd, generated.name), content: Buffer.from(generated.content, "utf8") }]);
      const runner = generated.name.endsWith(".py") ? "python3 " : generated.name.endsWith(".ts") ? "npx tsx " : generated.name.endsWith(".html") ? "python3 -m http.server 8000  # then open localhost:8000" : generated.name.endsWith(".jsx") || generated.name.endsWith(".sol") || generated.name.endsWith(".sql") || generated.name.endsWith(".md") ? "cat " : "node ";
      return NextResponse.json({
        ok: true, command, exitCode: 0,
        stdout: "Created " + path.join(cwd, generated.name) + "\nRun it with: " + runner + generated.name,
        stderr: "", durationMs: Date.now() - started, cwd
      });
    }
    const env: Record<string, string> = {};
    if (/\bvercel\b/.test(command) && process.env.CLOUDCLI_VERCEL_TOKEN) env.VERCEL_TOKEN = process.env.CLOUDCLI_VERCEL_TOKEN;
    const wrappedCommand = command + "\n__cloudcli_exit=$?\nprintf '\\n__CLOUDCLI_CWD__%s' \"$PWD\"\nexit \"$__cloudcli_exit\"";
    const result = await sandbox.runCommand({ cmd: "bash", args: ["-lc", wrappedCommand], cwd, env });
    const rawStdout = await result.stdout();
    const marker = "\n__CLOUDCLI_CWD__";
    const markerIndex = rawStdout.lastIndexOf(marker);
    let nextCwd = cwd;
    let stdout = rawStdout;
    if (markerIndex >= 0) {
      const reported = rawStdout.slice(markerIndex + marker.length).trim();
      try { nextCwd = resolveWorkspaceCwd(reported); } catch { nextCwd = cwd; }
      stdout = rawStdout.slice(0, markerIndex);
    }
    return NextResponse.json({
      ok: result.exitCode === 0, command, exitCode: result.exitCode,
      stdout: clip(stdout), stderr: clip(await result.stderr()), durationMs: Date.now() - started, cwd: nextCwd
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Command execution failed.";
    return NextResponse.json({ error: message.slice(0, 1200) }, { status: 500 });
  } finally {
    if (sandbox) { try { await sandbox.stop(); } catch { /* already stopped */ } }
  }
}
