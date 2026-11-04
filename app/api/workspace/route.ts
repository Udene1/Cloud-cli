import { NextRequest, NextResponse } from "next/server";
import path from "node:path";
import { isAuthenticated } from "@/lib/auth";
import { assertSafePath, getWorkspaceSandbox, MAX_TEXT_FILE, MAX_UPLOAD, workspacePath, WORKSPACE_ROOT } from "@/lib/workspace";

export const runtime = "nodejs";
export const maxDuration = 30;

function fail(error: unknown) {
  const message = error instanceof Error ? error.message : "Workspace operation failed.";
  const status = /outside the workspace|invalid workspace path/i.test(message) ? 400 : /ENOENT|not found/i.test(message) ? 404 : 500;
  return NextResponse.json({ error: message.slice(0, 500) }, { status });
}

export async function GET(request: NextRequest) {
  if (!isAuthenticated(request)) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const op = request.nextUrl.searchParams.get("op") || "list";
  let sandbox: Awaited<ReturnType<typeof getWorkspaceSandbox>> | undefined;
  try {
    sandbox = await getWorkspaceSandbox();
    const target = workspacePath(request.nextUrl.searchParams.get("path") || ".");
    await assertSafePath(sandbox, target);
    if (op === "download") {
      const stat = await sandbox.fs.stat(target);
      if (!stat.isFile()) return NextResponse.json({ error: "Select a file to download." }, { status: 400 });
      if (stat.size > MAX_UPLOAD) return NextResponse.json({ error: "Downloads are limited to 5 MB." }, { status: 413 });
      const buffer = await sandbox.readFileToBuffer({ path: target });
      if (!buffer) return NextResponse.json({ error: "File not found." }, { status: 404 });
      const filename = encodeURIComponent(path.basename(target));
      return new NextResponse(new Uint8Array(buffer), { headers: { "Content-Type": "application/octet-stream", "Content-Length": String(buffer.length), "Content-Disposition": "attachment; filename*=UTF-8''" + filename, "Cache-Control": "no-store" } });
    }
    if (op === "read") {
      const stat = await sandbox.fs.stat(target);
      if (!stat.isFile()) return NextResponse.json({ error: "Select a file to open." }, { status: 400 });
      if (stat.size > MAX_TEXT_FILE) return NextResponse.json({ error: "File is larger than 512 KB. Download it instead." }, { status: 413 });
      const content = await sandbox.fs.readFile(target, "utf8");
      return NextResponse.json({ ok: true, path: target, content });
    }
    if (op !== "list") return NextResponse.json({ error: "Unknown operation." }, { status: 400 });
    const stat = await sandbox.fs.stat(target);
    if (!stat.isDirectory()) return NextResponse.json({ error: "Path is not a directory." }, { status: 400 });
    const entries = await sandbox.fs.readdir(target, { withFileTypes: true });
    const items = await Promise.all(entries.map(async (entry: any) => {
      const fullPath = path.join(target, entry.name);
      const info = await sandbox!.fs.lstat(fullPath);
      return { name: entry.name, path: fullPath, kind: info.isSymbolicLink() ? "link" : info.isDirectory() ? "directory" : "file", size: info.size || 0 };
    }));
    items.sort((a, b) => a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "directory" ? -1 : 1);
    return NextResponse.json({ ok: true, path: target, parent: target === WORKSPACE_ROOT ? null : path.dirname(target), items });
  } catch (error) { return fail(error); }
  finally { if (sandbox) { try { await sandbox.stop(); } catch { /* snapshot may already be stopping */ } } }
}

export async function POST(request: NextRequest) {
  if (!isAuthenticated(request)) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  let body: any;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid request body." }, { status: 400 }); }
  const action = body?.action;
  let sandbox: Awaited<ReturnType<typeof getWorkspaceSandbox>> | undefined;
  try {
    sandbox = await getWorkspaceSandbox();
    const target = workspacePath(body.path);
    if (action === "mkdir") {
      const name = String(body.name || "").trim();
      if (!name || name === "." || name === ".." || /[\\/\0]/.test(name)) return NextResponse.json({ error: "Enter a valid folder name." }, { status: 400 });
      await assertSafePath(sandbox, target);
      await sandbox.fs.mkdir(path.join(target, name));
    } else if (action === "write") {
      const name = String(body.name || "").trim();
      const content = typeof body.content === "string" ? body.content : "";
      if (!name || name === "." || name === ".." || /[\\/\0]/.test(name)) return NextResponse.json({ error: "Enter a valid file name." }, { status: 400 });
      if (Buffer.byteLength(content, "utf8") > MAX_TEXT_FILE) return NextResponse.json({ error: "Text files are limited to 512 KB." }, { status: 413 });
      await assertSafePath(sandbox, target);
      const destination = path.join(target, name);
      await assertSafePath(sandbox, destination, true);
      await sandbox.fs.writeFile(destination, content, "utf8");
    } else if (action === "upload") {
      const name = String(body.name || "").trim();
      const encoded = typeof body.data === "string" ? body.data : "";
      if (!name || name === "." || name === ".." || /[\\/\0]/.test(name)) return NextResponse.json({ error: "Invalid upload filename." }, { status: 400 });
      const data = Buffer.from(encoded, "base64");
      if (!encoded || data.length > MAX_UPLOAD) return NextResponse.json({ error: "Uploads are limited to 5 MB." }, { status: 413 });
      await assertSafePath(sandbox, target);
      const destination = path.join(target, name);
      await assertSafePath(sandbox, destination, true);
      await sandbox.writeFiles([{ path: destination, content: data }]);
    } else return NextResponse.json({ error: "Unknown operation." }, { status: 400 });
    return NextResponse.json({ ok: true });
  } catch (error) { return fail(error); }
  finally { if (sandbox) { try { await sandbox.stop(); } catch { /* snapshot may already be stopping */ } } }
}

export async function DELETE(request: NextRequest) {
  if (!isAuthenticated(request)) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  let body: any;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid request body." }, { status: 400 }); }
  let sandbox: Awaited<ReturnType<typeof getWorkspaceSandbox>> | undefined;
  try {
    sandbox = await getWorkspaceSandbox();
    const target = workspacePath(body?.path);
    if (target === WORKSPACE_ROOT) return NextResponse.json({ error: "The workspace root cannot be deleted." }, { status: 400 });
    await assertSafePath(sandbox, target);
    await sandbox.fs.rm(target, { recursive: true, force: false });
    return NextResponse.json({ ok: true });
  } catch (error) { return fail(error); }
  finally { if (sandbox) { try { await sandbox.stop(); } catch { /* snapshot may already be stopping */ } } }
}
