"use client";
import { useCallback, useEffect, useState } from "react";
import "./github-integration.css";

type Repo = { nameWithOwner: string; description?: string | null; isPrivate: boolean; updatedAt?: string };
type Overview = { installed: boolean; authenticated: boolean; error?: string; message?: string; repositories?: Repo[] };
type Status = { path: string; branch: string; status: string; remote: string; log: string; branches: string[] };

export default function GitHubIntegration({ onOpenTerminal }: { onOpenTerminal: (command: string) => void }) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [selectedRepo, setSelectedRepo] = useState("");
  const [branchName, setBranchName] = useState("");
  const [commitMessage, setCommitMessage] = useState("");
  const [prTitle, setPrTitle] = useState("");

  const api = useCallback(async (url: string, init?: RequestInit) => {
    const response = await fetch(url, init);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "GitHub request failed.");
    return data;
  }, []);

  const refresh = useCallback(async () => {
    setBusy(true); setError("");
    try {
      const data = await api("/api/github?op=connection");
      setOverview(data);
      if (data.authenticated) {
        const repos = await api("/api/github?op=repositories");
        setOverview({ ...data, repositories: repos.repositories || [] });
      } else setStatus(null);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not check GitHub connection."); }
    finally { setBusy(false); }
  }, [api]);

  useEffect(() => { void refresh(); }, [refresh]);

  async function loadStatus(path: string) {
    setBusy(true); setError(""); setNotice("");
    try {
      const data = await api("/api/github?op=status&path=" + encodeURIComponent(path));
      setStatus(data); setSelectedRepo(path);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not load repository status."); }
    finally { setBusy(false); }
  }

  async function act(action: string, extra: Record<string, unknown> = {}) {
    if (!selectedRepo) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const data = await api("/api/github", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, path: selectedRepo, ...extra }) });
      setNotice(data.output || "Git operation completed.");
      await loadStatus(selectedRepo);
    } catch (e) { setError(e instanceof Error ? e.message : "Git operation failed."); }
    finally { setBusy(false); }
  }

  async function clone(repository: string) {
    setBusy(true); setError(""); setNotice("");
    try {
      const data = await api("/api/github", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "clone", repository }) });
      setNotice(data.output || "Repository cloned.");
      await loadStatus(data.path);
    } catch (e) { setError(e instanceof Error ? e.message : "Clone failed."); }
    finally { setBusy(false); }
  }

  async function copyConnectCommand() {
    try { await navigator.clipboard.writeText("gh auth login --hostname github.com --git-protocol https --web"); setNotice("Login command copied. Paste it into the interactive terminal."); }
    catch { setNotice("Run this in the interactive terminal: gh auth login --hostname github.com --git-protocol https --web"); }
    onOpenTerminal("gh auth login --hostname github.com --git-protocol https --web");
  }

  const repos = overview?.repositories || [];
  return <section className="github-panel">
    <div className="github-head">
      <div><span className="github-kicker">SOURCE CONTROL</span><h2>GitHub</h2><p>Connect your account, clone repositories, manage branches and publish changes.</p></div>
      <button className="gh-refresh" onClick={() => void refresh()} disabled={busy}>↻ Refresh</button>
    </div>

    {error && <div className="gh-alert">{error}</div>}
    {notice && <div className="gh-notice">{notice}</div>}

    {!overview && <div className="gh-card">Checking GitHub CLI connection…</div>}

    {overview && !overview.installed && <div className="gh-card gh-connect-card">
      <div className="gh-card-icon">⌘</div><div><h3>GitHub CLI is not available</h3><p>The sandbox needs the official <code>gh</code> command to authenticate securely and work with your repositories. Open the terminal and install it with the Ubuntu package manager, then refresh this page.</p><code className="gh-command">sudo apt-get update && sudo apt-get install -y gh</code><button className="gh-primary" onClick={onOpenTerminal}>Open interactive terminal ↗</button></div>
    </div>}

    {overview?.installed && !overview.authenticated && <div className="gh-card gh-connect-card">
      <div className="gh-card-icon">↗</div><div><h3>Connect your GitHub account</h3><p>CloudCLI uses GitHub CLI's device login. No personal access token needs to be pasted into CloudCLI.</p><code className="gh-command">gh auth login --hostname github.com --git-protocol https --web</code><button className="gh-primary" onClick={() => void copyConnectCommand()}>Copy command & open terminal ↗</button><small>In the terminal, paste the command. GitHub will show a one-time code and verification page. Complete the approval, then return here and refresh.</small></div>
    </div>}

    {overview?.authenticated && <div className="gh-connected"><span><i/> GITHUB CONNECTED</span><small>Authenticated through GitHub CLI in your private Sandbox.</small></div>}

    {overview?.authenticated && <div className="gh-layout">
      <aside className="gh-repos">
        <div className="gh-section-title"><b>Your repositories</b><small>{repos.length} shown</small></div>
        {repos.length === 0 && <p className="gh-empty">No repositories returned for this GitHub account.</p>}
        {repos.map((repo) => <div className="gh-repo" key={repo.nameWithOwner}>
          <div><b>{repo.nameWithOwner}</b><small>{repo.isPrivate ? "Private" : "Public"}{repo.description ? " · " + repo.description : ""}</small></div>
          <button disabled={busy} onClick={() => void clone(repo.nameWithOwner)}>Clone ↘</button>
        </div>)}
        <p className="gh-note">Cloned projects are stored in <code>/vercel/sandbox/repositories/</code>.</p>
      </aside>

      <div className="gh-worktree">
        {!status ? <div className="gh-empty-worktree"><span>⌁</span><b>Select a repository</b><small>Clone one from the list to inspect its Git status, branches and recent commits.</small></div> : <>
          <div className="gh-repo-title"><div><span>WORKING TREE</span><h3>{status.path.split("/").slice(-1)[0]}</h3><small>{status.remote.split("\n")[0] || "No remote configured"}</small></div><button onClick={() => void loadStatus(status.path)} disabled={busy}>↻</button></div>
          <div className="gh-branch-line"><span>⑂ {status.branch || "detached HEAD"}</span><select value={status.branch} onChange={(e) => void act("switch-branch", { branch: e.target.value })}><option value={status.branch}>{status.branch || "Current branch"}</option>{status.branches.filter(b => !b.startsWith("*") && !b.includes("->") && b.replace(/^remotes\/origin\//, "") !== status.branch).map(b => <option key={b} value={b.replace(/^remotes\/origin\//, "")}>{b.replace(/^remotes\/origin\//, "")}</option>)}</select></div>
          <div className="gh-branch-create"><input value={branchName} onChange={(e) => setBranchName(e.target.value)} placeholder="New branch name" /><button disabled={busy || !branchName.trim()} onClick={() => { void act("create-branch", { branch: branchName.trim() }); setBranchName(""); }}>＋ Branch</button></div>
          <div className="gh-section-title"><b>Working tree</b><button disabled={busy} onClick={() => void act("pull")}>↓ Pull</button></div>
          <pre className="gh-output">{status.status || "Working tree clean."}</pre>
          <div className="gh-commit-row"><input value={commitMessage} onChange={(e) => setCommitMessage(e.target.value)} placeholder="Commit message" /><button disabled={busy || !commitMessage.trim()} onClick={() => { void act("commit", { message: commitMessage }); setCommitMessage(""); }}>Commit</button></div>
          <div className="gh-actions"><button disabled={busy} onClick={() => void act("push")}>↑ Push current branch</button><button disabled={busy} onClick={() => void act("pull")}>↓ Sync</button></div>
          <div className="gh-section-title"><b>Recent commits</b></div><pre className="gh-log">{status.log || "No commits found."}</pre>
          <div className="gh-pr-row"><input value={prTitle} onChange={(e) => setPrTitle(e.target.value)} placeholder="Pull request title" /><button disabled={busy || !prTitle.trim()} onClick={() => { void act("create-pr", { title: prTitle.trim() }); setPrTitle(""); }}>Create PR ↗</button></div>
        </>}
      </div>
    </div>}
  </section>;
}
