"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Terminal as XTerm } from "@xterm/xterm";

type Props = { cwd: string; onCwdChange?: (cwd: string) => void };

export default function InteractiveTerminal({ cwd }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<XTerm | null>(null);
  const socket = useRef<WebSocket | null>(null);
  const [state, setState] = useState<"disconnected" | "connecting" | "connected" | "error">("disconnected");
  const [message, setMessage] = useState("Connect to start an interactive Bash session.");
  const [busy, setBusy] = useState(false);

  const connect = useCallback(async () => {
    if (busy || state === "connected") return;
    setBusy(true);
    setState("connecting");
    setMessage("Starting your persistent shell…");
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
          args: ["-l"],
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
          } catch { terminal.current?.write(event.data); }
        } else if (event.data instanceof ArrayBuffer) {
          terminal.current?.write(new Uint8Array(event.data));
        } else if (event.data instanceof Blob) {
          void event.data.arrayBuffer().then((buffer) => terminal.current?.write(new Uint8Array(buffer)));
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
  }, [busy, cwd, state]);

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
        if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(new TextEncoder().encode(input));
      });
      const resize = () => { addon.fit(); if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows })); };
      window.addEventListener("resize", resize);
      term.write("CloudCLI interactive terminal\\r\\n");
      term.write("Tap Connect to open a persistent Bash shell.\\r\\n");
      return () => window.removeEventListener("resize", resize);
    })();
    return () => {
      disposed = true;
      socket.current?.close();
      fit?.dispose();
      terminal.current?.dispose();
      terminal.current = null;
    };
  }, []);

  function sendKey(value: string) {
    if (socket.current?.readyState === WebSocket.OPEN) {
      socket.current.send(new TextEncoder().encode(value));
      terminal.current?.focus();
    }
  }

  const shortcuts = [
    ["Tab", "\\t"], ["Esc", "\\x1b"], ["Ctrl+C", "\\x03"], ["Ctrl+D", "\\x04"],
    ["Ctrl+O · Save", "\\x0f"], ["Ctrl+X · Exit", "\\x18"],
    ["↑", "\\x1b[A"], ["↓", "\\x1b[B"], ["←", "\\x1b[D"], ["→", "\\x1b[C"],
  ] as const;

  return <section className="interactive-panel">
    <div className="interactive-toolbar">
      <div className="interactive-status"><i className={state === "connected" ? "connected" : ""}/><span>{state === "connected" ? "SHELL CONNECTED" : state.toUpperCase()}</span></div>
      <button className="connect-button" onClick={() => state === "connected" ? socket.current?.close() : void connect()} disabled={busy}>
        {busy ? "Connecting…" : state === "connected" ? "Disconnect" : "Connect shell ↗"}
      </button>
    </div>
    <div className="xterm-host" ref={host} onClick={() => terminal.current?.focus()} />
    <div className="mobile-keys" aria-label="Terminal special keys">
      {shortcuts.map(([label, value]) => <button type="button" key={label} onClick={() => sendKey(value)} disabled={state !== "connected"}>{label}</button>)}
    </div>
    <div className="interactive-hint">{message} <span>For Nano: Ctrl+O saves · Enter confirms · Ctrl+X exits.</span></div>
  </section>;
}
