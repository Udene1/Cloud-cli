"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Terminal as XTerm } from "@xterm/xterm";

type Props = { cwd: string; onCwdChange?: (cwd: string) => void };
type ExternalAction = { url: string; host: string; trusted: boolean; code?: string };

const TRUSTED_HOSTS: Record<string, string> = {
  "github.com": "GitHub",
  "www.github.com": "GitHub",
  "vercel.com": "Vercel",
  "www.vercel.com": "Vercel",
  "cloudflare.com": "Cloudflare",
  "dash.cloudflare.com": "Cloudflare",
  "neon.tech": "Neon",
  "www.neon.tech": "Neon",
  "accounts.google.com": "Google",
  "npmjs.com": "npm",
  "www.npmjs.com": "npm",
};

function detectExternalAction(raw: string): ExternalAction | null {
  // Strip terminal colour/control sequences before inspecting output.
  const clean = raw.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "");
  const match = clean.match(/https:\/\/[A-Za-z0-9.-]+(?::\d+)?(?:\/[^\s"'<>]*)?/);
  if (!match) return null;
  const candidate = match[0].replace(/[),.;!?]+$/, "");
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "https:") return null;
    const host = parsed.hostname.toLowerCase();
    const trusted = Object.prototype.hasOwnProperty.call(TRUSTED_HOSTS, host);
    const code = clean.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/)?.[0];
    return { url: parsed.toString(), host, trusted, ...(code ? { code } : {}) };
  } catch {
    return null;
  }
}

export default function InteractiveTerminal({ cwd, onCwdChange }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<XTerm | null>(null);
  const socket = useRef<WebSocket | null>(null);
  const resizeHandler = useRef<(() => void) | null>(null);
  const ctrlArmedRef = useRef(false);
  const [ctrlArmed, setCtrlArmed] = useState(false);
  const [state, setState] = useState<"disconnected" | "connecting" | "connected" | "error">("disconnected");
  const [message, setMessage] = useState("Connect to start an interactive Bash session.");
  const [busy, setBusy] = useState(false);
  const [externalAction, setExternalAction] = useState<ExternalAction | null>(null);
  const [copied, setCopied] = useState(false);

  const writeOutput = useCallback((value: string | Uint8Array) => {
    terminal.current?.write(value);
    const text = typeof value === "string" ? value : new TextDecoder().decode(value);
    const detected = detectExternalAction(text);
    if (detected) {
      setExternalAction((previous) => previous?.url === detected.url && previous.code === detected.code ? previous : detected);
      setCopied(false);
    }
  }, []);

  const connect = useCallback(async () => {
    if (busy || state === "connected") return;
    setBusy(true);
    setState("connecting");
    setMessage("Starting your persistent shell…");
    setExternalAction(null);
    try {
      const response = await fetch("/api/terminal/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Unable to start terminal.");
      const ws = new WebSocket(data.url + "?token=" + encodeURIComponent(data.token));
      ws.binaryType = "arraybuffer";
      socket.current = ws;
      ws.onopen = () => {
        const term = terminal.current;
        ws.send(JSON.stringify({
          type: "start",
          command: "bash",
          args: ["--noprofile", "--norc", "-i"],
          env: [
            "TERM=xterm-256color",
            "COLORTERM=truecolor",
            "PS1=\\[\\e[38;5;75m\\]ken@cloudcli \\w \\[$\\] ",
          ],
          cwd: data.cwd || "/vercel/sandbox",
          cols: term?.cols || 80,
          rows: term?.rows || 24,
        }));
        setState("connected");
        setMessage("Interactive shell connected.");
        term?.focus();
      };
      ws.onmessage = (event) => {
        if (typeof event.data === "string") {
          try {
            const control = JSON.parse(event.data);
            if (control.type === "exit") {
              setState("disconnected");
              setMessage("Shell exited. Reconnect to start a new shell.");
            } else if (control.type === "error") {
              setMessage(control.message || "Terminal error.");
            }
          } catch { writeOutput(event.data); }
        } else if (event.data instanceof ArrayBuffer) {
          writeOutput(new Uint8Array(event.data));
        } else if (event.data instanceof Blob) {
          void event.data.arrayBuffer().then((buffer) => writeOutput(new Uint8Array(buffer)));
        }
      };
      ws.onerror = () => { setState("error"); setMessage("Terminal connection failed. Try reconnecting."); };
      ws.onclose = () => {
        setState((current) => current === "error" ? "error" : "disconnected");
        socket.current = null;
      };
    } catch (error) {
      setState("error");
      setMessage(error instanceof Error ? error.message : "Terminal connection failed.");
    } finally { setBusy(false); }
  }, [busy, cwd, state, writeOutput]);

  useEffect(() => {
    if (!host.current || terminal.current) return;
    let disposed = false;
    let fit: { fit: () => void; dispose: () => void } | undefined;
    void (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);
      if (disposed || !host.current) return;
      const term = new Terminal({
        cursorBlink: true,
        convertEol: true,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: 13,
        lineHeight: 1.35,
        theme: { background: "#090d12", foreground: "#d6e0ea", cursor: "#7dd3fc", selectionBackground: "#26445e" },
        scrollback: 5000,
        allowProposedApi: true,
      });
      const addon = new FitAddon();
      term.loadAddon(addon);
      term.open(host.current);
      addon.fit();
      terminal.current = term;
      fit = addon;
      term.onData((input) => {
        let outgoing = input;
        if (ctrlArmedRef.current && input.length === 1) {
          const code = input.toLowerCase().charCodeAt(0);
          if (code >= 97 && code <= 122) outgoing = String.fromCharCode(code - 96);
          ctrlArmedRef.current = false;
          setCtrlArmed(false);
        }
        if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(new TextEncoder().encode(outgoing));
      });
      const resize = () => { addon.fit(); if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows })); };
      window.addEventListener("resize", resize);
      resizeHandler.current = resize;
      term.write("CloudCLI interactive terminal\r\n");
      term.write("Tap Connect to open a persistent Bash shell.\r\n");
    })();
    return () => {
      disposed = true;
      socket.current?.close();
      if (resizeHandler.current) window.removeEventListener("resize", resizeHandler.current);
      resizeHandler.current = null;
      fit?.dispose();
      terminal.current?.dispose();
      terminal.current = null;
    };
  }, []);

  function armCtrl() { ctrlArmedRef.current = true; setCtrlArmed(true); terminal.current?.focus(); }

  function sendKey(value: string) {
    if (socket.current?.readyState === WebSocket.OPEN) {
      socket.current.send(new TextEncoder().encode(value));
      terminal.current?.focus();
    }
  }

  async function copyCode() {
    if (!externalAction?.code) return;
    try {
      await navigator.clipboard.writeText(externalAction.code);
      setCopied(true);
    } catch {
      const field = document.createElement("textarea");
      field.value = externalAction.code;
      field.setAttribute("readonly", "");
      field.style.position = "fixed";
      field.style.opacity = "0";
      document.body.appendChild(field);
      field.select();
      const ok = document.execCommand("copy");
      field.remove();
      setCopied(ok);
    }
  }

  function openExternal() {
    if (!externalAction) return;
    const service = TRUSTED_HOSTS[externalAction.host];
    if (!service && !window.confirm(`This command wants to open ${externalAction.host}. Only continue if you trust the source. Open this site?`)) return;
    window.open(externalAction.url, "_blank", "noopener,noreferrer");
  }

  const shortcuts = [
    ["Tab", "\t"], ["Esc", "\x1b"], ["Ctrl+C", "\x03"], ["Ctrl+D", "\x04"],
    ["Ctrl+O · Save", "\x0f"], ["Ctrl+X · Exit", "\x18"],
    ["↑", "\x1b[A"], ["↓", "\x1b[B"], ["←", "\x1b[D"], ["→", "\x1b[C"],
  ] as const;

  return <section className="interactive-panel">
    <div className="interactive-toolbar">
      <div className="interactive-status"><i className={state === "connected" ? "connected" : ""}/><span>{state === "connected" ? "SHELL CONNECTED" : state.toUpperCase()}</span></div>
      <button className="connect-button" onClick={() => state === "connected" ? socket.current?.close() : void connect()} disabled={busy}>
        {busy ? "Connecting…" : state === "connected" ? "Disconnect" : "Connect shell ↗"}
      </button>
    </div>
    {externalAction && <div className="external-action" role="status">
      <div className="external-action-copy">
        <b>{externalAction.code ? "Authentication needs your approval" : "External link detected"}</b>
        <span>{TRUSTED_HOSTS[externalAction.host] || externalAction.host} · {externalAction.trusted ? "Recognized service" : "Unverified destination"}</span>
        {externalAction.code && <code>{externalAction.code}</code>}
      </div>
      <div className="external-action-buttons">
        {externalAction.code && <button type="button" onClick={() => void copyCode()}>{copied ? "Code copied ✓" : "Copy code"}</button>}
        <button type="button" className="external-open" onClick={openExternal}>Open {TRUSTED_HOSTS[externalAction.host] || "website"} ↗</button>
        <button type="button" className="external-dismiss" onClick={() => setExternalAction(null)} aria-label="Dismiss external link">×</button>
      </div>
    </div>}
    <div className="xterm-host" ref={host} onClick={() => terminal.current?.focus()} />
    <div className="mobile-keys" aria-label="Terminal special keys">
      <button type="button" className={ctrlArmed ? "armed" : ""} onClick={armCtrl} disabled={state !== "connected"}>Ctrl{ctrlArmed ? " · armed" : ""}</button>
      {shortcuts.map(([label, value]) => <button type="button" key={label} onClick={() => sendKey(value)} disabled={state !== "connected"}>{label}</button>)}
    </div>
    <div className="interactive-hint">{message} <span>For Nano: Ctrl+O saves · Enter confirms · Ctrl+X exits.</span></div>
  </section>;
}
