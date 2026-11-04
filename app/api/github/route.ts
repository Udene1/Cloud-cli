import { NextRequest, NextResponse } from "next/server";
import { Sandbox } from "@vercel/sandbox";
import { isAuthenticated } from "@/lib/auth";
import { assertSafePath, WORKSPACE_ROOT, workspacePath } from "@/lib/workspace";

export const runtime = "nodejs";
export const maxDuration = 30;

type CommandResult = { stdout: string; stderr: string; exitCode: number };
async function run(sandbox: Sandbox, cmd: string, args: string[] = [], cwd = WORKSPACE_ROOT): Promise<CommandResult> {
  const result = await sandbox.runCommand({ cmd, args, cwd });
  return { stdout: await result.stdout(), stderr: await result.stderr(), exitCode: result.exitCode };
}
function safeRepo(value: unknown) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) throw new Error("Choose a valid owner/repository.");
  return value;
}
function safeBranch(value: unknown) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(value) || value.includes("..") || value.endsWith("/") || value.endsWith(".lock")) throw new Error("Invalid branch name.");
  return value;
}
function safeMessage(value: unknown) {
  if (typeof value !== "string" || !value.trim() || value.length > 200) throw new Error("Enter a commit message (maximum 200 characters).");
  return value.trim();
}
function responseError(message: string, status = 400) {
  return NextResponse.json({ error: message.slice(0, 700) }, { status });
}
async function openSandbox() {
  return Sandbox.getOrCreate({
    name: "cloudcli-workspace",
    timeout: 45 * 60 * 1000,
    persistent: true,
    resources: { vcpus: 1 },
    resume: true,
  });
}
async function repoDirectory(sandbox: Sandbox, raw: unknown) {
  const directory = workspacePath(raw);
  if (directory === WORKSPACE_ROOT) throw new Error("Select a cloned repository folder first.");
  await assertSafePath(sandbox, directory);
  const stat = await sandbox.fs.stat(directory);
  if (!stat.isDirectory()) throw new Error("Repository path must be a folder.");
  const check = await run(sandbox, "git", ["rev-parse", "--is-inside-work-tree"], directory);
  if (check.exitCode !== 0 || check.stdout.trim() !== "true") throw new Error("That folder is not a Git repository. Clone it first.");
  return directory;
}

export async function GET(request: NextRequest) {
  if (!isAuthenticated(request)) return responseError("Unauthorized.", 401);
  let sandbox: Sandbox | undefined;
  try {
    sandbox = await openSandbox();
    const op = request.nextUrl.searchParams.get("op") || "overview";
    const ghVersion = await run(sandbox, "bash", ["-lc", "command -v gh >/dev/null 2>&1"]);
    const installed = ghVersion.exitCode === 0;
    if (!installed) return NextResponse.json({ installed: false, authenticated: false, error: "GitHub CLI (gh) is not installed in this workspace yet." });
    const auth = await run(sandbox, "gh", ["auth", "status"]);
    const authenticated = auth.exitCode === 0;
    if (authenticated) await run(sandbox, "gh", ["auth", "setup-git"]);
    if (op === "connection") {
      return NextResponse.json({ installed, authenticated, message: authenticated ? "GitHub connected." : "GitHub is not connected. Run the device login from the terminal." });
    }
    if (!authenticated) return NextResponse.json({ installed, authenticated: false, error: "Connect GitHub from the terminal first." }, { status: 409 });
    if (op === "repositories") {
      const repos = await run(sandbox, "gh", ["repo", "list", "--json", "nameWithOwner,description,isPrivate,updatedAt", "--limit", "50"]);
      if (repos.exitCode !== 0) return responseError(repos.stderr || "Could not list GitHub repositories.", 502);
      let items: unknown[] = [];
      try { items = JSON.parse(repos.stdout); } catch { return responseError("GitHub returned an unreadable repository list.", 502); }
      return NextResponse.json({ installed, authenticated, repositories: items });
    }
    if (op === "status") {
      const directory = await repoDirectory(sandbox, request.nextUrl.searchParams.get("path"));
      const [branch, status, remote, log, branches] = await Promise.all([
        run(sandbox, "git", ["branch", "--show-current"], directory),
        run(sandbox, "git", ["status", "--short", "--branch"], directory),
        run(sandbox, "git", ["remote", "-v"], directory),
        run(sandbox, "git", ["log", "-6", "--oneline", "--decorate"], directory),
        run(sandbox, "git", ["branch", "--all", "--no-color"], directory),
      ]);
      return NextResponse.json({
        installed, authenticated, path: directory,
        branch: branch.stdout.trim(),
        status: status.stdout,
        remote: remote.stdout,
        log: log.stdout,
        branches: branches.stdout.split("\n").map(x => x.trim()).filter(Boolean),
      });
    }
    return responseError("Unknown GitHub operation.");
  } catch (error) {
    const message = error instanceof Error ? error.message : "GitHub request failed.";
    return responseError(message, /ENOENT|not found/i.test(message) ? 404 : 400);
  } finally {
    if (sandbox) await sandbox.stop().catch(() => undefined);
  }
}

export async function POST(request: NextRequest) {
  if (!isAuthenticated(request)) return responseError("Unauthorized.", 401);
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return responseError("Invalid request body."); }
  let sandbox: Sandbox | undefined;
  try {
    sandbox = await openSandbox();
    const action = body.action;
    if (action === "clone") {
      const repository = safeRepo(body.repository);
      const slug = repository.split("/")[1];
      const target = workspacePath("repositories/" + slug);
      await sandbox.runCommand({ cmd: "mkdir", args: ["-p", workspacePath("repositories")], cwd: WORKSPACE_ROOT });
      const exists = await sandbox.fs.stat(target).then(() => true).catch(() => false);
      if (exists) return responseError("A folder with this repository name already exists in /repositories. Remove or rename it before cloning.");
      const result = await run(sandbox, "gh", ["repo", "clone", repository, target], WORKSPACE_ROOT);
      if (result.exitCode !== 0) return responseError(result.stderr || result.stdout || "Clone failed.", 502);
      return NextResponse.json({ ok: true, path: target, output: result.stdout || "Repository cloned." });
    }
    const directory = await repoDirectory(sandbox, body.path);
    if (action === "create-branch") {
      const branch = safeBranch(body.branch);
      const result = await run(sandbox, "git", ["switch", "-c", branch], directory);
      if (result.exitCode !== 0) return responseError(result.stderr || "Could not create branch.", 409);
      return NextResponse.json({ ok: true, output: result.stdout || "Created branch " + branch });
    }
    if (action === "switch-branch") {
      const branch = safeBranch(body.branch);
      const result = await run(sandbox, "git", ["switch", branch], directory);
      if (result.exitCode !== 0) return responseError(result.stderr || "Could not switch branch.", 409);
      return NextResponse.json({ ok: true, output: result.stdout || "Switched to " + branch });
    }
    if (action === "pull") {
      const result = await run(sandbox, "git", ["pull", "--ff-only"], directory);
      if (result.exitCode !== 0) return responseError(result.stderr || "Pull failed.", 409);
      return NextResponse.json({ ok: true, output: result.stdout || "Already up to date." });
    }
    if (action === "commit") {
      const message = safeMessage(body.message);
      const add = await run(sandbox, "git", ["add", "-A"], directory);
      if (add.exitCode !== 0) return responseError(add.stderr || "Could not stage changes.", 409);
      const staged = await run(sandbox, "git", ["diff", "--cached", "--name-only"], directory);
      const risky = staged.stdout.split("\n").filter((name) => /(^|\/)\.env($|\.(?!example$))|\.(pem|key)$|(^|\/)(id_rsa|credentials\.json|secrets?\.[^/]+)$/i.test(name));
      if (risky.length) {
        await run(sandbox, "git", ["reset", "-q", "--", ...risky], directory);
        return responseError("Commit blocked: sensitive-looking files were excluded from staging: " + risky.join(", ") + ". Review them and stage only files you intend to publish.", 409);
      }
      const commit = await run(sandbox, "git", ["commit", "-m", message], directory);
      if (commit.exitCode !== 0) return responseError(commit.stderr || "Commit failed. There may be no changes to commit.", 409);
      return NextResponse.json({ ok: true, output: commit.stdout });
    }
    if (action === "push") {
      const result = await run(sandbox, "git", ["push", "-u", "origin", "HEAD"], directory);
      if (result.exitCode !== 0) return responseError(result.stderr || "Push failed.", 502);
      return NextResponse.json({ ok: true, output: result.stdout || "Pushed current branch." });
    }
    if (action === "create-pr") {
      const title = safeMessage(body.title);
      const args = ["pr", "create", "--title", title, "--body", typeof body.body === "string" ? body.body.slice(0, 5000) : "Created from CloudCLI."];
      const result = await run(sandbox, "gh", args, directory);
      if (result.exitCode !== 0) return responseError(result.stderr || "Could not create pull request.", 502);
      return NextResponse.json({ ok: true, output: result.stdout });
    }
    return responseError("Unknown GitHub action.");
  } catch (error) {
    const message = error instanceof Error ? error.message : "GitHub operation failed.";
    return responseError(message, /ENOENT|not found/i.test(message) ? 404 : 400);
  } finally {
    if (sandbox) await sandbox.stop().catch(() => undefined);
  }
}
