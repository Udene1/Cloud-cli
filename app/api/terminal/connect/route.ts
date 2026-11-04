import { NextRequest, NextResponse } from "next/server";
import { Sandbox } from "@vercel/sandbox";
import { isAuthenticated } from "@/lib/auth";

export const runtime = "nodejs";
export const maxDuration = 30;

const WORKSPACE_ROOT = "/vercel/sandbox";

export async function POST(request: NextRequest) {
  if (!isAuthenticated(request)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  let body: { cwd?: unknown };
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: "Invalid request body." }, { status: 400 }); }

  const requested = typeof body.cwd === "string" ? body.cwd : WORKSPACE_ROOT;
  const cwd = requested.startsWith(WORKSPACE_ROOT) ? requested : WORKSPACE_ROOT;
  if (cwd !== WORKSPACE_ROOT && !cwd.startsWith(WORKSPACE_ROOT + "/")) {
    return NextResponse.json({ error: "Working directory must stay inside the workspace." }, { status: 400 });
  }

  try {
    const sandbox = await Sandbox.getOrCreate({
      name: "cloudcli-workspace",
      timeout: 45 * 60 * 1000,
      persistent: true,
      resources: { vcpus: 1 },
      resume: true,
    });
    await sandbox.runCommand({ cmd: "mkdir", args: ["-p", WORKSPACE_ROOT], cwd: "/" });
    const { url, token } = await sandbox.openInteractive();
    return NextResponse.json({ ok: true, url, token, cwd });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not open interactive terminal.";
    return NextResponse.json({ error: message.slice(0, 1000) }, { status: 500 });
  }
}
