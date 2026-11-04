# CloudCLI

A private, browser-based cloud command centre built with Next.js and Vercel Sandbox.

## Capabilities

- Private single-owner password login.
- Shell command execution inside a persistent Vercel Sandbox microVM.
- Workspace files persist between commands and browser sessions.
- Built-in starter generation: `generate node`, `generate python`, `generate typescript`, and `generate html`.
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
