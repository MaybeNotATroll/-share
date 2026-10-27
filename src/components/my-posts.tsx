"use client";

import { useCallback, useEffect, useState } from "react";
import { readableBytes } from "@/src/lib/usage-display";

type Post = { id: string; code: string; name: string; size: number; createdAt: string; expiresAt: string };

export function MyPosts() {
  const [posts, setPosts] = useState<Post[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const load = useCallback(async (next?: string | null) => {
    setBusy(true);
    try {
      const response = await fetch(`/api/owner${next ? `?cursor=${encodeURIComponent(next)}` : ""}`, { cache: "no-store" });
      if (response.status === 401) {
        setPosts([]);
        setCursor(null);
        setError("");
        return;
      }
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Could not load your posts.");
      setPosts((current) => next ? [...current, ...data.files] : data.files);
      setCursor(data.nextCursor ?? null);
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load your posts.");
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  // Expiration is enforced by the server; refresh this view while it stays open.
  useEffect(() => {
    const timer = window.setInterval(() => void load(), 60_000);
    return () => window.clearInterval(timer);
  }, [load]);
  async function remove(post: Post) {
    if (deleting || !window.confirm(`Delete “${post.name}”? This cannot be undone and does not restore your daily upload allowance.`)) return;
    setDeleting(post.id);
    try {
      const response = await fetch(`/api/owner/files/${post.id}`, { method: "DELETE", cache: "no-store" });
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error ?? "Deletion failed. Please retry.");
      }
      setPosts((current) => current.filter((item) => item.id !== post.id));
      setError("");
      window.dispatchEvent(new Event("numa-usage-changed"));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Deletion failed. Please retry.");
    } finally {
      setDeleting(null);
    }
  }
  return (
    <main className="space-shell">
      <header className="topbar"><a className="brand" href="/">numa</a><a href="/">← Home</a></header>
      <section className="space-header"><div><h1>My Posts</h1>
        <p className="space-subtitle">Active files created with this browser’s private owner cookie. Bookmark this page to return.</p>
        <p className="space-subtitle">Keep cookies enabled. Clearing cookies, private browsing ending, or changing browsers loses management access permanently. Space numbers cannot recover ownership. Older uploads cannot be claimed.</p>
      </div></section>
      {error && <p className="notice notice-error" role="alert">{error}</p>}
      <button className="button button-secondary" disabled={busy} onClick={() => void load()}>{busy ? "Loading…" : "Refresh"}</button>
      <section className="files-section" aria-label="Your active posts" aria-busy={busy}>
        {!busy && posts.length === 0 && !error && <p>No active posts found for this browser. Upload a file in a space to get started.</p>}
        <div className="file-grid">
          {posts.map((post) => (
            <article className="file-card owner-card" key={post.id}>
              <h2>{post.name}</h2>
              <p>{readableBytes(post.size)}</p>
              <p>Created: <time dateTime={post.createdAt}>{new Date(post.createdAt).toLocaleString()}</time></p>
              <p>Expires: <time dateTime={post.expiresAt}>{new Date(post.expiresAt).toLocaleString()}</time></p>
              <div className="button-row">
                <a className="button button-secondary" href={`/space/${post.code}`}>Open space</a>
                <button className="button button-secondary danger-outline" disabled={deleting !== null} onClick={() => void remove(post)}>{deleting === post.id ? "Deleting…" : "Delete"}</button>
              </div>
            </article>
          ))}
        </div>
        {cursor && <button className="button button-secondary load-more" disabled={busy} onClick={() => void load(cursor)}>Load more</button>}
      </section>
    </main>
  );
}
