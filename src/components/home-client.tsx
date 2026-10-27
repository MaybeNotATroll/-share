"use client";

import { FormEvent, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { formatCode, isValidSpaceCode } from "@/src/lib/code";
import { copyText } from "@/src/lib/clipboard";

export function HomeClient() {
  const router = useRouter();
  const busyRef = useRef(false);
  const [code, setCode] = useState("");
  const [generated, setGenerated] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  function openSpace(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = code.trim();
    if (!isValidSpaceCode(value)) {
      setError("Enter a code made of 1 to 100 digits.");
      return;
    }
    setError("");
    router.push(`/space/${value}`);
  }

  async function generatePrivateNumber() {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    setGenerated(null);
    try {
      const response = await fetch("/api/spaces/generate", {
        method: "POST",
        cache: "no-store",
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || typeof payload.code !== "string") {
        throw new Error(payload.error ?? "Could not generate a number. Please try again.");
      }
      setCopied(false);
      setGenerated(payload.code);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not generate a number. Please try again.");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function copy(value: string) {
    try {
      await copyText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2200);
    } catch {
      setError("Could not copy. Select and copy the code manually.");
    }
  }

  return (
    <main className="home-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="Numa home">
          <span className="brand-mark" aria-hidden="true">n</span>
          <span>numa</span>
        </a>
        <span className="topbar-note">File sharing, by number</span>
      </header>

      <section className="hero">
        <div className="eyebrow"><span className="status-dot" /> A quieter way to share</div>
        <h1>Your files.<br /><span>One number away.</span></h1>
        <p className="hero-copy">
          Enter a number to open its private space, or generate a new one to share with people you trust.
        </p>

        <div className="entry-card">
          <form onSubmit={openSpace} noValidate>
            <label htmlFor="space-code">Space number</label>
            <div className="code-entry">
              <span className="hash-mark" aria-hidden="true">#</span>
              <input
                id="space-code"
                name="space-code"
                type="text"
                inputMode="numeric"
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                maxLength={100}
                pattern="[0-9]{1,100}"
                placeholder="Type or paste a number"
                value={code}
                onChange={(event) => {
                  setCode(event.target.value);
                  setError("");
                }}
                aria-describedby={error ? "home-error" : "code-help"}
              />
            </div>
            <p className="field-help" id="code-help">Keep every digit, including any leading zeroes.</p>
            <button className="button button-primary open-button" type="submit">
              Open space <span aria-hidden="true">↗</span>
            </button>
          </form>

          <div className="divider"><span>or</span></div>
          <button
            className="button button-secondary generate-button"
            type="button"
            onClick={generatePrivateNumber}
            disabled={busy}
          >
            <span className="sparkle" aria-hidden="true">✳</span>
            {busy ? "Finding an unused number…" : "Generate a private number"}
          </button>
          {generated && (
            <div className="generated-panel" aria-live="polite">
              <p className="generated-label">Your private number is ready</p>
              <p className="generated-code" aria-label={`Private code: ${generated}`}>
                {formatCode(generated)}
              </p>
              <p className="credential-warning">
                Nothing has been posted under this number yet. Save it now — anyone with the number
                can view and add files, and it cannot be recovered if lost.
              </p>
              <div className="button-row">
                <button className="button button-secondary" type="button" onClick={() => copy(generated)}>
                  {copied ? "Code copied" : "Copy code"}
                </button>
                <a className="button button-primary" href={`/space/${generated}`}>
                  Open space ↗
                </a>
              </div>
            </div>
          )}
          {error && <p className="notice notice-error" id="home-error" role="alert">{error}</p>}
        </div>

        <div className="privacy-cards">
          <article>
            <span className="privacy-icon private-icon" aria-hidden="true">⌁</span>
            <h2>Every number is private</h2>
            <p>Files can only be listed, viewed, or added by someone who enters the exact number.</p>
          </article>
          <article>
            <span className="privacy-icon public-icon" aria-hidden="true">◎</span>
            <h2>Nothing gets deleted</h2>
            <p>Anyone with the number can view and post files, but cannot delete what was shared.</p>
          </article>
        </div>
      </section>

      <footer className="site-footer">
        <span>Share thoughtfully.</span>
        <span>Short numbers are easy to guess. Use a generated 100-digit number for real privacy.</span>
      </footer>
    </main>
  );
}
