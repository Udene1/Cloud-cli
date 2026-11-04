"use client";

import { ChangeEvent, useCallback, useEffect, useRef, useState } from "react";
import "./workspace-explorer.css";

type Item = { name: string; path: string; kind: "directory" | "file" | "link"; size: number };
type Listing = { path: string; parent: string | null; items: Item[] };

function prettySize(size: number) {
  if (size < 1024) return size + " B";
  if (size < 1024 * 1024) return (size / 1024).toFixed(1) + " KB";
  return (size / (1024 * 1024)).toFixed(1) + " MB";
}
function relative(path: string) { return path.replace(/^\/vercel\/sandbox\/?/, "") || ""; }

export default function WorkspaceExplorer({ onOpenTerminal }: { onOpenTerminal: (cwd: string) => void }) {
  const [listing, setListing] = useState<Listing | null>(null);
  const [selected, setSelected] = useState("");
  const [content, setContent] = useState("");
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [newKind, setNewKind] = useState<"file" | "folder" | null>(null);
  const [newName, setNewName] = useState("");
  const upload = useRef<HTMLInputElement>(null);

  const request = useCallback(async (url: string, init?: RequestInit) => {
    const response = await fetch(url, init);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Workspace request failed.");
    return data;
  }, []);

  const refresh = useCallback(async (directory = listing?.path || "/vercel/sandbox") => {
    setBusy(true); setError("");
    try { const data = await request("/api/workspace?op=list&path=" + encodeURIComponent(directory)); setListing(data); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not load directory."); }
    finally { setBusy(false); }
  }, [listing?.path, request]);

  useEffect(() => { void refresh("/vercel/sandbox"); }, []); // initial workspace listing

  async function openFile(item: Item) {
    if (dirty && !window.confirm("Discard unsaved changes?")) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const data = await request("/api/workspace?op=read&path=" + encodeURIComponent(item.path));
      setSelected(item.path); setContent(data.content); setDirty(false);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not open file."); }
    finally { setBusy(false); }
  }

  async function save() {
    if (!selected || !listing) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const name = selected.split("/").pop() || "";
      const directory = selected.slice(0, selected.lastIndexOf("/"));
      await request("/api/workspace", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "write", path: directory, name, content }) });
      setDirty(false); setNotice("Saved " + name); await refresh(listing.path);
    } catch (e) { setError(e instanceof Error ? e.message : "Save failed."); }
    finally { setBusy(false); }
  }

  async function createEntry() {
    if (!listing || !newName.trim()) return;
    setBusy(true); setError("");
    try {
      await request("/api/workspace", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: newKind === "folder" ? "mkdir" : "write", path: listing.path, name: newName.trim(), content: "" }) });
      setNewName(""); setNewKind(null); await refresh(listing.path);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not create item."); }
    finally { setBusy(false); }
  }

  async function removeItem(item: Item) {
    if (!window.confirm("Delete " + item.name + "? This cannot be undone.")) return;
    setBusy(true); setError("");
    try {
      await request("/api/workspace", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: item.path }) });
      if (selected === item.path) { setSelected(""); setContent(""); setDirty(false); }
      await refresh(listing?.path);
    } catch (e) { setError(e instanceof Error ? e.message : "Delete failed."); }
    finally { setBusy(false); }
  }

  async function uploadFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file || !listing) return;
    if (file.size > 5 * 1024 * 1024) { setError("Uploads are limited to 5 MB."); event.target.value = ""; return; }
    setBusy(true); setError("");
    try {
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(",")[1] || ""); reader.onerror = () => reject(new Error("Could not read upload."));
        reader.readAsDataURL(file);
      });
      await request("/api/workspace", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "upload", path: listing.path, name: file.name, data }) });
      await refresh(listing.path); setNotice("Uploaded " + file.name);
    } catch (e) { setError(e instanceof Error ? e.message : "Upload failed."); }
    finally { setBusy(false); event.target.value = ""; }
  }

  async function download(item: Item) {
    try {
      const response = await fetch("/api/workspace?op=read&path=" + encodeURIComponent(item.path));
      if (!response.ok) { const data = await response.json(); throw new Error(data.error || "Download failed."); }
      const blob = await response.blob(); const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a"); anchor.href = url; anchor.download = item.name; anchor.click(); URL.revokeObjectURL(url);
    } catch (e) { setError(e instanceof Error ? e.message : "Download failed."); }
  }

  const crumbs = listing ? listing.path.replace("/vercel/sandbox", "").split("/").filter(Boolean) : [];
  return <section className="explorer">
    <div className="explorer-head"><div><span className="explorer-kicker">PERSISTENT FILESYSTEM</span><h2>Project files</h2></div><button onClick={() => void refresh()} disabled={busy}>↻ Refresh</button></div>
    <div className="explorer-toolbar">
      <button onClick={() => { setNewKind("file"); setNewName(""); }}>＋ File</button>
      <button onClick={() => { setNewKind("folder"); setNewName(""); }}>＋ Folder</button>
      <button onClick={() => upload.current?.click()}>↑ Upload</button>
      <input ref={upload} type="file" hidden onChange={uploadFile} />
      <button onClick={() => listing && onOpenTerminal(listing.path)}>Open terminal here ↗</button>
    </div>
    <div className="explorer-path"><button onClick={() => void refresh("/vercel/sandbox")}>workspace</button>{crumbs.map((crumb, index) => {
      const path = "/vercel/sandbox/" + crumbs.slice(0, index + 1).join("/");
      return <span key={path}> / <button onClick={() => void refresh(path)}>{crumb}</button></span>;
    })}</div>
    {error && <div className="explorer-alert">{error}</div>}{notice && <div className="explorer-notice">{notice}</div>}
    {newKind && <form className="new-entry" onSubmit={(e) => { e.preventDefault(); void createEntry(); }}><input autoFocus value={newName} onChange={(e) => setNewName(e.target.value)} placeholder={newKind === "folder" ? "Folder name" : "File name"} /><button disabled={busy || !newName.trim()}>Create</button><button type="button" onClick={() => setNewKind(null)}>Cancel</button></form>}
    <div className="explorer-grid">
      <div className="file-list">
        {listing?.parent && <button className="file-row parent-row" onClick={() => void refresh(listing.parent!)}><span>↰</span><b>..</b><small>Parent folder</small></button>}
        {listing?.items.map((item) => <div className={selected === item.path ? "file-row selected" : "file-row"} key={item.path}>
          <button className="file-main" onClick={() => item.kind === "directory" ? void refresh(item.path) : item.kind === "file" ? void openFile(item) : setError("Symbolic links are not opened in the explorer.")}>
            <span className="file-icon">{item.kind === "directory" ? "▰" : item.kind === "link" ? "↗" : "▤"}</span><b>{item.name}</b><small>{item.kind === "directory" ? "Folder" : item.kind === "link" ? "Link blocked" : prettySize(item.size)}</small>
          </button>
          {item.kind === "file" && <button className="row-action" title="Download" onClick={() => void download(item)}>↓</button>}
          <button className="row-action danger" title="Delete" onClick={() => void removeItem(item)}>×</button>
        </div>)}
        {!busy && listing?.items.length === 0 && <p className="empty-files">This folder is empty. Create a file or upload one.</p>}
        {busy && <p className="empty-files">Working…</p>}
      </div>
      <div className="file-editor">
        {selected ? <><div className="editor-head"><span>▤ &nbsp;{relative(selected)}</span><button onClick={() => void save()} disabled={!dirty || busy}>{busy ? "Saving…" : dirty ? "Save changes" : "Saved ✓"}</button></div><textarea spellCheck={false} value={content} onChange={(e) => { setContent(e.target.value); setDirty(true); }} placeholder="File contents…" /></> : <div className="editor-empty"><span>⌘</span><b>Select a file to edit</b><small>Text files up to 512 KB can be edited here. Binary files can be uploaded and downloaded.</small></div>}
      </div>
    </div>
    <p className="explorer-foot">Files live in the same persistent Vercel Sandbox as your terminal. Upload limit 5 MB · editor limit 512 KB.</p>
  </section>;
}
