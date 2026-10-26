"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { formatCode, spaceCodeSchema } from "@/src/lib/code";

type GeneratedSpace = { code: string; managementCredential: string };

async function copyText(value: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const field = document.createElement("textarea");
  field.value = value;
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.opacity = "0";
  document.body.append(field);
  field.select();
  const copied = document.execCommand("copy");
  field.remove();
  if (!copied) throw new Error("Copy is not available in this browser.");
}

export function HomeClient() {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [generated, setGenerated] = useState<GeneratedSpace | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState("");

  function openSpace(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = code.trim();
    if (!spaceCodeSchema.safeParse(value).success) {
      setError("Enter a code made of 1 to 100 digits.");
      return;
    }
    setError("");
    router.push(`/space/${value}`);
  }

  async function generatePrivateNumber() {
    if (busy) return;
    setBusy(true);
    setError("");
    setGenerated(null);
    try {
      const response = await fetch("/api/spaces/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        cache: "no-store",
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Could not create a private space.");
      setGenerated(payload as GeneratedSpace);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not create a private space.");
    } finally {
      setBusy(false);
    }
  }

  async function copy(value: string, label: string) {
    try {
      await copyText(value);
      setCopied(label);
      window.setTimeout(() => setCopied(""), 2200);
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
          Enter a number to open its space, or make a private one to share with people you trust.
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
            {busy ? "Creating your private space…" : "Generate a private number"}
          </button>
          {generated && (
            <div className="generated-panel" aria-live="polite">
              <p className="generated-label">Your private number is ready</p>
              <p className="generated-code" aria-label={`Private code: ${generated.code}`}>
                {formatCode(generated.code)}
              </p>
              <p className="credential-warning">
                Save both credentials now. Anyone with the number can access this space; only the
                separate management key can delete its files. The management key is shown once.
              </p>
              <div className="credential-box">
                <span>Management key</span>
                <code>{generated.managementCredential}</code>
              </div>
              <div className="button-row">
                <button className="button button-secondary" onClick={() => copy(generated.code, "code")}>
                  {copied === "code" ? "Number copied" : "Copy number"}
                </button>
                <button
                  className="button button-secondary"
                  onClick={() => copy(generated.managementCredential, "key")}
                >
                  {copied === "key" ? "Key copied" : "Copy management key"}
                </button>
                <a className="button button-primary" href={`/space/${generated.code}`} target="_blank" rel="noreferrer">
                  Open space ↗
                </a>
              </div>
            </div>
          )}
          {error && <p className="notice notice-error" id="home-error" role="alert">{error}</p>}
        </div>

        <div className="privacy-cards">
          <article>
            <span className="privacy-icon public-icon" aria-hidden="true">◎</span>
            <h2>Public spaces</h2>
            <p>Short numbers are open to everyone. Anyone who enters one can see and add files.</p>
          </article>
          <article>
            <span className="privacy-icon private-icon" aria-hidden="true">⌁</span>
            <h2>Private spaces</h2>
            <p>Long numbers are unlisted, not encrypted. Anyone who gets the number can access it.</p>
          </article>
        </div>
      </section>

      <footer className="site-footer">
        <span>Share thoughtfully.</span>
        <span>Anything in a public space may be viewed and downloaded by anyone.</span>
      </footer>
    </main>
  );
}
