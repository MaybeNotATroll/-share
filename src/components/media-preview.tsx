"use client";

import { useEffect, useState } from "react";

export function MediaPreview({
  code,
  file,
}: {
  code: string;
  file: { id: string; name: string; contentType: string };
}) {
  const [url, setUrl] = useState("");
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setUrl("");
    setFailed(false);

    async function load() {
      try {
        const response = await fetch(`/api/spaces/${code}/files/${file.id}?mode=preview`, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("Preview unavailable.");
        const payload = await response.json();
        if (typeof payload.url !== "string" || !payload.url) throw new Error("Preview unavailable.");
        if (!controller.signal.aborted) setUrl(payload.url);
      } catch {
        if (!controller.signal.aborted) setFailed(true);
      }
    }

    void load();
    return () => controller.abort();
  }, [code, file.id, attempt]);

  return (
    <div className="file-preview">
      {failed ? (
        <div role="status">
          <p>Preview unavailable.</p>
          <button className="text-button" type="button" onClick={() => setAttempt((current) => current + 1)}>
            Retry preview
          </button>
        </div>
      ) : !url ? (
        <p role="status">Loading preview…</p>
      ) : file.contentType.startsWith("image/") ? (
        <img src={url} alt={`Preview of ${file.name}`} onError={() => setFailed(true)} />
      ) : (
        <video src={url} controls preload="auto" playsInline aria-label={`Preview of ${file.name}`} onError={() => setFailed(true)} />
      )}
    </div>
  );
}
