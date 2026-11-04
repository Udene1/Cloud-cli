"use client";
import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from "react";

type Entry = { id: number; command: string; stdout?: string; stderr?: string; exitCode?: number; durationMs?: number; error?: string };
const quick = [
  ["Runtime versions", "node --version && npm --version && python3 --version", "Check installed runtimes"],
  ["Vercel CLI", "npx vercel --version", "Check the Vercel CLI"],
  ["Provision isolated Neon", "npx vercel integration add neon --name fund-database --billing-plan free_v3 --meta region=lhr1 --prefix FUND_DB_", "Requires a Vercel token configured for CloudCLI"],
  ["Generate Node script", "generate node hello.js", "Create a starter file in your workspace"],
  ["Generate Python script", "generate python hello.py", "Create a Python starter file"],
  ["List workspace files", "ls -la", "Inspect persistent workspace files"]
];
const helpText = [
  "CloudCLI commands", "",
  "  help                              Show this help",
  "  clear                             Clear the terminal",
  "  generate node <filename>          Generate a Node.js starter",
  "  generate python <filename>        Generate a Python starter",
  "  generate typescript <filename>    Generate a TypeScript starter",
  "  generate html <filename>          Generate an HTML starter", "",
  "Everything else runs as a shell command inside your persistent Vercel Sandbox workspace.", "",
  "Examples:", "  npx vercel --version", "  npm init -y", "  npx create-next-app@latest my-app",
  "  git clone https://github.com/owner/repo.git", "  ls -la"
].join("\n");

export default function Home() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [command, setCommand] = useState("");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [running, setRunning] = useState(false);
  const [tab, setTab] = useState("Terminal");
  const input = useRef<HTMLTextAreaElement>(null);
  const nextId = useRef(1);

  useEffect(() => {
    fetch("/api/auth/session").then((r) => r.json()).then((d) => setAuthenticated(Boolean(d.authenticated))).catch(() => setAuthenticated(false));
  }, []);

  async function login(event: FormEvent) {
    event.preventDefault(); setLoginError("");
    const r = await fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }) });
    const data = await r.json();
    if (!r.ok) { setLoginError(data.error || "Unable to sign in."); return; }
    setAuthenticated(true); setPassword("");
  }
  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" }); setAuthenticated(false); setEntries([]);
  }
  async function run(raw: string) {
    const value = raw.trim();
    if (!value || running) return;
    setCommand("");
    if (value === "clear") { setEntries([]); return; }
    if (value === "help") { setEntries((old) => [...old, { id: nextId.current++, command: value, stdout: helpText, exitCode: 0 }]); return; }
    const id = nextId.current++;
    setEntries((old) => [...old, { id, command: value }]); setRunning(true);
    try {
      const r = await fetch("/api/execute", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ command: value }) });
      const data = await r.json();
      setEntries((old) => old.map((e) => e.id === id ? { ...e, stdout: data.stdout, stderr: data.stderr, exitCode: data.exitCode, durationMs: data.durationMs, error: data.error } : e));
      if (r.status === 401) setAuthenticated(false);
    } catch {
      setEntries((old) => old.map((e) => e.id === id ? { ...e, error: "Connection failed. Check your network and retry." } : e));
    } finally { setRunning(false); setTimeout(() => input.current?.focus(), 50); }
  }
  function submit(e: FormEvent) { e.preventDefault(); void run(command); }
  function keyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void run(command); }
  }

  if (authenticated === null) return <main className="loading"><div className="mark">C</div><span>Starting CloudCLI…</span></main>;
  if (!authenticated) return (
    <main className="login-screen"><div className="login-card">
      <div className="brand"><div className="mark">C</div><div><b>CloudCLI</b><small>YOUR CLOUD COMMAND CENTRE</small></div></div>
      <p className="eyebrow">PRIVATE WORKSPACE</p><h1>Welcome back.</h1>
      <p className="muted">Sign in to access your cloud terminal and persistent workspace.</p>
      <form onSubmit={login}><label htmlFor="password">Workspace password</label><input id="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required placeholder="Enter your password" />{loginError && <p className="error">{loginError}</p>}<button className="primary">Open workspace ↗</button></form>
      <div className="login-foot">PRIVATE ACCESS · ISOLATED EXECUTION</div>
    </div></main>
  );

  return <main className="shell">
    <aside className="sidebar">
      <div className="brand"><div className="mark">C</div><div><b>CloudCLI</b><small>COMMAND CENTRE</small></div></div>
      <p className="side-label">WORKSPACE</p>
      <button className={tab === "Terminal" ? "nav active" : "nav"} onClick={() => setTab("Terminal")}>⌘ &nbsp; Terminal</button>
      <button className={tab === "Quick commands" ? "nav active" : "nav"} onClick={() => setTab("Quick commands")}>⚡ &nbsp; Quick commands</button>
      <div className="side-bottom"><div className="online"><i/> <span><b>Sandbox ready</b><small>Persistent workspace</small></span></div><button className="account" onClick={logout}><span className="avatar">K</span><span><b>Owner workspace</b><small>Sign out</small></span></button></div>
    </aside>
    <section className="main">
      <header className="topbar"><span>Workspace&nbsp; / &nbsp;<b>{tab}</b></span><div><small>LHR · LONDON</small><strong>⌑ PRIVATE</strong></div></header>
      <div className="content">
        <div className="heading"><div><p className="eyebrow">CLOUD OPERATIONS / 01</p><h1>{tab}</h1><p className="muted">{tab === "Terminal" ? "Run commands, generate code and work across your cloud projects." : "One-click workflows for common development and infrastructure tasks."}</p></div><span className="ready"><i/> SYSTEM READY</span></div>
        {tab === "Quick commands" && <div className="quick-grid">{quick.map(([label, cmd, detail]) => <button className="quick" key={label} onClick={() => { setTab("Terminal"); void run(cmd); }}><b>{label} ↗</b><small>{detail}</small><code>{cmd}</code></button>)}</div>}
        <section className="terminal">
          <div className="terminal-head"><div className="lights"><i/><i/><i/></div><span>cloudcli / workspace / bash</span><small>● LIVE SESSION</small></div>
          <div className="terminal-body" onClick={() => input.current?.focus()}>
            <div className="welcome"><span>✳</span><div><b>CloudCLI workspace initialized</b><p>Linux environment ready. Your files persist between commands.</p><small>Type <button onClick={(e) => { e.stopPropagation(); void run("help"); }}>help</button> to see available commands.</small></div></div>
            {entries.map((e) => <div className="entry" key={e.id}><div className="cmd"><b>ken@cloudcli ~ $</b> {e.command}</div>{e.stdout && <pre>{e.stdout}</pre>}{e.stderr && <pre className="stderr">{e.stderr}</pre>}{e.error && <pre className="stderr">{e.error}</pre>}{e.exitCode !== undefined && <small className={e.exitCode === 0 ? "success" : "failure"}>{e.exitCode === 0 ? "✓ completed" : "× exit " + e.exitCode} {e.durationMs ? " · " + (e.durationMs / 1000).toFixed(2) + "s" : ""}</small>}</div>)}
            {running && <div className="running">◌ Executing in isolated sandbox…</div>}
            <form className="command-form" onSubmit={submit}><b>ken@cloudcli ~ $</b><textarea ref={input} rows={1} value={command} onChange={(e) => setCommand(e.target.value)} onKeyDown={keyDown} disabled={running} placeholder={running ? "Command running…" : "Enter a command…"} /><button disabled={running || !command.trim()}>↵</button></form>
          </div>
          <footer><span>● Connected to persistent workspace</span><span>ENTER to run · SHIFT + ENTER for new line</span></footer>
        </section>
        <div className="features"><article><b>⌘ &nbsp; Isolated execution</b><p>Commands run inside a Vercel Sandbox microVM, separate from the web app.</p></article><article><b>▤ &nbsp; Persistent files</b><p>Your workspace files survive between commands and browser sessions.</p></article></div>
        <p className="disclaimer">CloudCLI runs commands you submit. Review destructive commands before execution. App environment secrets are not automatically exposed to the sandbox.</p>
      </div>
    </section>
  </main>;
}
