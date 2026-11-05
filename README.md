# CloudCLI

A private, browser-based cloud command centre built with Next.js and Vercel Sandbox.

## Capabilities

- Private single-owner password login.
- Shell command execution inside a persistent Vercel Sandbox microVM.
- Workspace files persist between commands and browser sessions.
- Built-in starter generation: `generate node`, `generate python`, `generate typescript`, `generate html`, `generate react`, `generate solidity`, `generate sql`, and `generate markdown`.
- Browser-local command history (last 100 commands), recalled with the up/down arrow keys; `Ctrl/Cmd + L` clears the visible terminal.
- Quick command launcher, output, exit status and execution time.

## Architecture

- Next.js App Router hosted on Vercel.
- `@vercel/sandbox` creates/resumes the named `cloudcli-workspace` microVM.
- Each command runs inside that microVM, separate from the web app.
- The sandbox is stopped after each command so its filesystem can be snapshotted and resumed.
- No database is required for the first version.

## Required Vercel environment variables

Set these as **Encrypted** variables for Production, Preview and Development:

- `CLOUDCLI_PASSWORD`: private workspace login password.
- `CLOUDCLI_SESSION_SECRET`: random secret of at least 32 characters.

Optional:

- `CLOUDCLI_VERCEL_TOKEN`: a team-scoped Vercel access token. When configured, it is passed to the sandbox only for commands containing the Vercel CLI, as `VERCEL_TOKEN`. Treat this as a powerful credential. The owner can run arbitrary shell commands, so only configure a token scoped to the intended team and revoke it if exposed.

Vercel Sandbox uses the deployment's OIDC identity to create and manage sandboxes. The sandbox does not automatically receive the app's environment variables.

## Local development

```bash
npm install
npm run dev
```

For local sandbox execution, link the Vercel project and pull its development OIDC token. Configure the two CloudCLI authentication variables locally.

## Example commands

```bash
help
ls -la
node --version
npx vercel --version
npm init -y
npx create-next-app@latest my-app
generate node hello.js
generate python hello.py
vercel integration add neon --name fund-database --billing-plan free_v3 --meta region=lhr1 --prefix FUND_DB_
```

## Security

This is a single-owner developer tool, not a public multi-user shell service. Keep deployment access protected by its login. Commands can modify or delete files inside the sandbox. They execute in an isolated microVM rather than in the Next.js function. Network access is enabled for package managers and cloud CLIs. Keep credentials scoped and rotate them if exposed.

The login uses a signed, HTTP-only, SameSite=Strict cookie. Durable login throttling and a dedicated credential vault are future hardening work before supporting multiple users.
## GitHub integration

The GitHub workspace uses the official GitHub CLI (gh) inside the same persistent Sandbox as the terminal and file explorer.

1. Open **GitHub** in CloudCLI. If gh is missing, install it in the interactive terminal:
   ```bash
   sudo apt-get update && sudo apt-get install -y gh
   ```
2. Choose **Copy command & open terminal**, then run:
   ```bash
   gh auth login --hostname github.com --git-protocol https --web
   ```
3. Complete GitHub's one-time device verification and return to the GitHub tab.

CloudCLI then lists your repositories and can clone them into /vercel/sandbox/repositories/, inspect status and commits, create/switch branches, pull, commit, push, and open pull requests. Git credential-helper setup is applied through gh auth setup-git.

GitHub CLI stores its OAuth credential in the private persistent Sandbox user configuration, not in the browser or CloudCLI's application environment. The GitHub API routes are protected by the CloudCLI owner session and expose only fixed Git operations; they do not accept arbitrary shell commands. The commit action blocks common secret filenames (such as .env, private keys, and credential files), but always inspect the staged diff before publishing. Disconnect with gh auth logout --hostname github.com in the terminal; this removes the CLI's stored GitHub credential from the workspace.

## MCP server (foundation)

CloudCLI exposes a stateless MCP Streamable HTTP endpoint at `/api/mcp`. The connected model supplies reasoning; CloudCLI supplies persistent workspace and shell execution tools.

Configure `CLOUDCLI_MCP_TOKEN` as an encrypted Vercel environment variable (Production, Preview, and Development as appropriate). Generate a high-entropy random token of at least 32 characters. MCP clients must send it as:

```http
Authorization: Bearer <CLOUDCLI_MCP_TOKEN>
```

Endpoint: `https://<your-cloudcli-host>/api/mcp`

Initial tools:
- `workspace_list` — list workspace files and directories.
- `workspace_read` — read a UTF-8 text file (512 KB limit).
- `workspace_write` — create or replace a UTF-8 text file (512 KB limit).
- `workspace_mkdir` — create a directory.
- `terminal_execute` — execute a shell command (3,000 character limit) and return exit status and output.

All file paths and working directories are confined to `/vercel/sandbox`. The sandbox is persistent across tool calls. The endpoint implements JSON-RPC initialization, tool discovery, tool calls, and notifications over HTTP; it does not require a separate AI model or memory service.

**Security:** This is an owner-level execution credential. Anyone holding the MCP token can read and modify workspace files and run shell commands in the persistent sandbox, including commands that may access credentials already installed in that sandbox. Only connect trusted MCP clients. Keep the token encrypted, never paste it into project files or chat, and rotate it immediately if exposed. CloudCLI does not send its Vercel application environment variables to the sandbox through this MCP endpoint.
