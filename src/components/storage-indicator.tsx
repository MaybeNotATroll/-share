"use client";

import { useEffect, useState } from "react";
import { readableBytes, usageProgress, type Usage } from "@/src/lib/usage-display";

export function StorageIndicator() {
  const [usage, setUsage] = useState<Usage | null>(null);
  useEffect(() => {
    let active = true;
    let pending = false;
    async function refresh() {
      if (pending) return;
      pending = true;
      try {
        const response = await fetch("/api/usage", { cache: "no-store" });
        const data = await response.json();
        if (active) setUsage(response.ok && usageProgress(data) !== null ? data : null);
      } catch {
        if (active) setUsage(null);
      } finally {
        pending = false;
      }
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), 60_000);
    window.addEventListener("numa-usage-changed", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener("numa-usage-changed", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, []);
  const progress = usage ? usageProgress(usage) : null;
  const description = usage
    ? `This IP's daily upload allowance: ${readableBytes(usage.uploadedBytes)} uploaded, ${readableBytes(usage.reservedBytes)} reserved, ${readableBytes(usage.limitBytes)} maximum. Resets ${new Date(usage.resetAt).toLocaleString()}. Shared by people on the same network; deletion does not refund it. Not total stored files.`
    : "This IP's daily upload usage is unavailable. Not total stored files.";
  return (
    <aside className="storage-indicator" aria-label="Upload allowance">
      <div className="usage-ring" role="img" aria-label={description} title={description}>
        <svg viewBox="0 0 64 64" aria-hidden="true">
          <circle className="usage-track" cx="32" cy="32" r="28" />
          <circle className="usage-fill" cx="32" cy="32" r="28" pathLength="100" strokeDasharray={`${progress ?? 0} 100`} />
        </svg>
        <span aria-hidden="true">{usage ? readableBytes(usage.uploadedBytes + usage.reservedBytes) : "—"}</span>
      </div>
      <div><strong>Daily IP uploads</strong><small>{usage ? `${readableBytes(usage.limitBytes)} limit · incl. reserved` : "Usage unavailable"}</small><a href="/my-posts">My Posts →</a></div>
    </aside>
  );
}
