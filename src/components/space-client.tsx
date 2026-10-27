"use client";

import { ChangeEvent, DragEvent, FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { formatCode, isValidSpaceCode } from "@/src/lib/code";
import { copyText } from "@/src/lib/clipboard";
import { FILE_TYPES } from "@/src/lib/file-types";
import { MediaPreview } from "@/src/components/media-preview";
import { uploadQuotaMessage, type UploadQuota } from "@/src/lib/upload-quota";

type FileRecord = {
  id: string;
  name: string;
  contentType: string;
  size: number;
  createdAt: string;
  expiresAt: string;
};
type SpaceRecord = { code: string; createdAt: string | null };
type UploadStatus = { name: string; progress: number; status: "uploading" | "failed" | "done"; error?: string };

const ACCEPTED = Object.keys(FILE_TYPES).map((extension) => `.${extension}`).join(",");

function prettySize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let amount = bytes / 1024;
  let index = 0;
  while (amount >= 1024 && index < units.length - 1) {
    amount /= 1024;
    index += 1;
  }
  return `${amount.toFixed(amount < 10 ? 1 : 0)} ${units[index]}`;
}

function prettyDate(date: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(date));
}

function xhrUpload(
  url: string,
  file: File,
  contentType: string,
  progress: (value: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("content-type", contentType);
    xhr.setRequestHeader("If-None-Match", "*");
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) progress(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error("The file could not be uploaded. Try again."));
    };
    xhr.onerror = () => reject(new Error("Network error while uploading. Check your connection."));
    xhr.onabort = () => reject(new Error("Upload was interrupted."));
    xhr.send(file);
  });
}

async function responseJson(response: Response) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(uploadErrorMessage(payload));
  return payload;
}

function uploadErrorMessage(payload: { error?: string; reason?: string; quota?: UploadQuota }) {
  if (payload.reason === "daily_upload_limit" && payload.quota) {
    const localReset = new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium", timeStyle: "long",
    }).format(new Date(payload.quota.resetAt));
    return uploadQuotaMessage(payload.quota, `${localReset} (midnight UTC)`);
  }
  return payload.error ?? "Something went wrong. Please try again.";
}

export function SpaceClient({ code }: { code: string }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const uploadingRef = useRef(false);
  const [space, setSpace] = useState<SpaceRecord | null>(null);
  const [files, setFiles] = useState<FileRecord[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [uploads, setUploads] = useState<UploadStatus[]>([]);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [reporting, setReporting] = useState("");
  const [expiresInSeconds, setExpiresInSeconds] = useState(86400);

  const validCode = isValidSpaceCode(code);

  const loadFiles = useCallback(async (nextCursor?: string | null) => {
    const suffix = nextCursor ? `&cursor=${encodeURIComponent(nextCursor)}` : "";
    const response = await fetch(`/api/spaces/${code}/files?limit=24${suffix}`, { cache: "no-store" });
    const payload = await responseJson(response);
    if (nextCursor) setFiles((current) => [...current, ...payload.files]);
    else setFiles(payload.files);
    setCursor(payload.nextCursor);
  }, [code]);

  useEffect(() => {
    let active = true;
    async function initialize() {
      setLoading(true);
      if (!validCode) {
        setError("This number is not valid. Enter between 1 and 100 digits.");
        setLoading(false);
        return;
      }
      try {
        const response = await fetch(`/api/spaces/${code}`, { cache: "no-store" });
        const payload = await responseJson(response);
        if (!active) return;
        setSpace(payload.space);
        const listResponse = await fetch(`/api/spaces/${code}/files?limit=24`, { cache: "no-store" });
        const list = await responseJson(listResponse);
        if (!active) return;
        setFiles(list.files);
        setCursor(list.nextCursor);
        setError("");
      } catch (reason) {
        if (active) setError(reason instanceof Error ? reason.message : "Space could not be opened.");
      } finally {
        if (active) setLoading(false);
      }
    }
    initialize();
    return () => { active = false; };
  }, [code, validCode]);

  async function copyCode() {
    try {
      await copyText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Could not copy the code. Select and copy it manually.");
    }
  }

  async function uploadFiles(selected: FileList | File[]) {
    const selectedFiles = Array.from(selected);
    if (!selectedFiles.length || uploadingRef.current) return;
    if (selectedFiles.length > 5) {
      setError("Choose no more than 5 files at a time.");
      return;
    }
    uploadingRef.current = true;
    setError("");
    setUploading(true);
    setUploads(selectedFiles.map((file) => ({ name: file.name, progress: 0, status: "uploading" })));
    try {
      const reserve = () => fetch(`/api/spaces/${code}/files`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expiresInSeconds,
          files: selectedFiles.map((file) => ({ name: file.name, size: file.size, type: file.type })),
        }),
        cache: "no-store",
      });
      const start = navigator.locks
        ? await navigator.locks.request("numa-owner-reservation", reserve)
        : await reserve();
      const payload = await start.json();
      if (!start.ok && !Array.isArray(payload.rejected)) throw new Error(uploadErrorMessage(payload));
      const { uploads: reservations, rejected = [] } = payload;
      for (const rejection of rejected) {
        setUploads((current) => current.map((upload, index) =>
          index === rejection.index
            ? { ...upload, status: "failed", error: uploadErrorMessage(rejection) }
            : upload
        ));
      }
      const results = await Promise.allSettled(
        reservations.map(async (reservation: { id: string; uploadUrl: string; contentType: string; index: number }) => {
          const index = reservation.index;
          try {
            await xhrUpload(reservation.uploadUrl, selectedFiles[index], reservation.contentType, (progress) => {
              setUploads((current) => current.map((upload, item) =>
                item === index ? { ...upload, progress } : upload
              ));
            });
            const finish = await fetch(`/api/spaces/${code}/files/${reservation.id}/complete`, {
              method: "POST",
              cache: "no-store",
            });
            await responseJson(finish);
            setUploads((current) => current.map((upload, item) =>
              item === index ? { ...upload, progress: 100, status: "done" } : upload
            ));
          } catch (reason) {
            await fetch(`/api/spaces/${code}/files/${reservation.id}/cancel`, {
              method: "POST",
              cache: "no-store",
            }).catch(() => undefined);
            setUploads((current) => current.map((upload, item) =>
              item === index
                ? { ...upload, status: "failed", error: reason instanceof Error ? reason.message : "Upload failed." }
                : upload
            ));
            throw reason;
          }
        }),
      );
      if (rejected.length || results.some((result) => result.status === "rejected")) {
        setError("Some files could not be uploaded. Failed files can be selected again.");
      }
      await loadFiles();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Upload could not be started.");
      setUploads((current) =>
        current.map((upload) => upload.status === "uploading"
          ? { ...upload, status: "failed", error: "Upload could not be started." }
          : upload
        ),
      );
    } finally {
      window.dispatchEvent(new Event("numa-usage-changed"));
      uploadingRef.current = false;
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  function onInputChange(event: ChangeEvent<HTMLInputElement>) {
    if (event.currentTarget.files) void uploadFiles(event.currentTarget.files);
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    void uploadFiles(event.dataTransfer.files);
  }

  async function openPreview(file: FileRecord) {
    if (previews[file.id]) {
      setPreviews((current) => {
        const next = { ...current };
        delete next[file.id];
        return next;
      });
      return;
    }
    try {
      const response = await fetch(`/api/spaces/${code}/files/${file.id}?mode=preview`, { cache: "no-store" });
      const payload = await responseJson(response);
      setPreviews((current) => ({ ...current, [file.id]: payload.url }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Preview is unavailable.");
    }
  }

  async function downloadFile(file: FileRecord) {
    try {
      const response = await fetch(`/api/spaces/${code}/files/${file.id}?mode=download`, { cache: "no-store" });
      const payload = await responseJson(response);
      window.location.assign(payload.url);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Download is unavailable.");
    }
  }

  async function report(file: FileRecord, event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const reason = new FormData(form).get("reason");
    try {
      const response = await fetch("/api/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, fileId: file.id, reason }),
        cache: "no-store",
      });
      await responseJson(response);
      setReporting(file.id);
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : "Report could not be submitted.");
    }
  }

  async function moreFiles() {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      await loadFiles(cursor);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "More files could not be loaded.");
    } finally {
      setLoadingMore(false);
    }
  }

  if (loading) {
    return <main className="space-shell"><div className="loading-card" role="status">Opening space…</div></main>;
  }

  if (!space) {
    return (
      <main className="space-shell">
        <header className="topbar"><a className="brand" href="/"><span className="brand-mark">n</span><span>numa</span></a></header>
        <section className="unavailable-card">
          <span className="eyebrow">Space unavailable</span>
          <h1>We couldn’t open that number.</h1>
          <p role="alert">{error || "Check the number and try again."}</p>
          <a className="button button-primary" href="/">Back to home</a>
        </section>
      </main>
    );
  }

  return (
    <main className="space-shell">
      <header className="topbar space-topbar">
        <a className="brand" href="/" aria-label="Numa home"><span className="brand-mark">n</span><span>numa</span></a>
        <a className="back-link" href="/">← <span>Home</span></a>
      </header>

      <section className="space-header">
        <div>
          <div className="eyebrow"><span className="status-dot" /> Private space</div>
          <h1 className="space-code">{formatCode(space.code)}</h1>
          <p className="space-subtitle">
            Only people with this exact number can view and add files. Files expire within 24 hours; only their owner or the operator can delete them.
          </p>
        </div>
        <button className="button button-secondary copy-code-button" onClick={copyCode}>
          {copied ? "Copied" : "Copy code"}
        </button>
      </section>

      {error && <p className="notice notice-error" role="alert">{error}<button onClick={() => setError("")} aria-label="Dismiss error">×</button></p>}

      <div className="expiration-choice">
        <label htmlFor="upload-expiration">Expire new uploads after </label>
        <select id="upload-expiration" value={expiresInSeconds} disabled={uploading} onChange={(event) => setExpiresInSeconds(Number(event.target.value))}>
          <option value={3600}>1 hour</option>
          <option value={21600}>6 hours</option>
          <option value={43200}>12 hours</option>
          <option value={86400}>24 hours (default)</option>
        </select>
        <p>Measured from upload reservation. Manage your files in <a href="/my-posts">My Posts</a> using this browser. Losing its cookies loses ownership access.</p>
      </div>
      <section
        className={`upload-zone ${dragging ? "is-dragging" : ""} ${uploading ? "is-uploading" : ""}`}
        onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
        onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false); }}
        onDrop={onDrop}
        aria-label="Upload files"
      >
        <input ref={inputRef} className="visually-hidden" type="file" multiple accept={ACCEPTED} onChange={onInputChange} aria-label="Choose files to upload" />
        <span className="upload-symbol" aria-hidden="true">↑</span>
        <div>
          <h2>{uploading ? "Uploading your files…" : "Drop files here"}</h2>
          <p>Images, videos, PDFs, and documents · 500 MB total per IP per UTC day · one file can use the full allowance</p>
        </div>
        <button className="button button-primary" type="button" disabled={uploading} onClick={() => inputRef.current?.click()}>
          Choose files
        </button>
      </section>

      {uploads.length > 0 && (
        <section className="upload-progress" aria-live="polite">
          {uploads.map((upload, index) => (
            <div className="progress-row" key={`${upload.name}-${index}`}>
              <span className={`progress-state ${upload.status}`}>{upload.status === "done" ? "✓" : upload.status === "failed" ? "!" : "↑"}</span>
              <div className="progress-copy">
                <div className={upload.error ? "has-error" : undefined}><strong>{upload.name}</strong><span>{upload.error ?? (upload.status === "done" ? "Uploaded" : `${upload.progress}%`)}</span></div>
                <progress value={upload.status === "done" ? 100 : upload.progress} max="100" aria-label={`${upload.name} upload progress`} />
              </div>
            </div>
          ))}
        </section>
      )}

      <section className="files-section">
        <div className="section-heading">
          <div><h2>Shared files</h2><p>{files.length === 0 ? "A fresh space, ready for a file." : `${files.length}${cursor ? "+" : ""} ${files.length === 1 ? "file" : "files"} loaded`}</p></div>
        </div>
        {files.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon" aria-hidden="true">▱</div>
            <h3>Nothing here yet</h3>
            <p>Nothing has been posted under this number. Add the first file.</p>
          </div>
        ) : (
          <div className="file-grid">
            {files.map((file) => {
              const isImage = file.contentType.startsWith("image/");
              const isVideo = file.contentType.startsWith("video/");
              const isPdf = file.contentType === "application/pdf";
              return (
                <article className="file-card" key={file.id}>
                  {(isImage || isVideo) && <MediaPreview key={`${code}-${file.id}`} code={code} file={file} />}
                  {isPdf && previews[file.id] && (
                    <div className="file-preview">
                      <iframe src={previews[file.id]} title={`PDF preview: ${file.name}`} sandbox="allow-same-origin" />
                    </div>
                  )}
                  <div className="file-card-body">
                    <div className="file-type-mark" aria-hidden="true">{file.contentType.split("/").pop()?.slice(0, 4).toUpperCase() ?? "FILE"}</div>
                    <div className="file-details">
                      <h3 title={file.name}>{file.name}</h3>
                      <p>{prettySize(file.size)} <span>·</span> {prettyDate(file.createdAt)}</p>
                      <p>Expires {prettyDate(file.expiresAt)}</p>
                    </div>
                  </div>
                  <div className="file-actions">
                    {isPdf && (
                      <button className="text-button" type="button" onClick={() => void openPreview(file)}>
                        {previews[file.id] ? "Hide preview" : "Preview"}
                      </button>
                    )}
                    <button className="text-button" type="button" onClick={() => void downloadFile(file)}>Download</button>
                    <details className="report-menu">
                      <summary>Report</summary>
                      <form onSubmit={(event) => void report(file, event)}>
                        <label htmlFor={`reason-${file.id}`}>Reason</label>
                        <select id={`reason-${file.id}`} name="reason" defaultValue="abuse">
                          <option value="illegal">Illegal content</option>
                          <option value="abuse">Abuse or harmful content</option>
                          <option value="copyright">Copyright concern</option>
                          <option value="other">Other concern</option>
                        </select>
                        <button className="text-button" type="submit">{reporting === file.id ? "Reported" : "Send report"}</button>
                      </form>
                    </details>
                  </div>
                </article>
              );
            })}
          </div>
        )}
        {cursor && (
          <button className="button button-secondary load-more" onClick={() => void moreFiles()} disabled={loadingMore}>
            {loadingMore ? "Loading…" : "Load more files"}
          </button>
        )}
      </section>

      <footer className="space-footer">
        <span>Files in this space are stored privately.</span>
        <a href="/">Create or open another space</a>
      </footer>
    </main>
  );
}
