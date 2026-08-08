"use client";

import { useEffect, useEffectEvent, useState, useTransition } from "react";
import { PresentationStage } from "../components/presentation-stage";
import {
  createEmptySnapshot,
  isDisplayCode,
  normalizeDisplayCode,
  parseDisplaySnapshot,
  type DisplaySnapshot,
} from "../lib/display-snapshot";

const STORAGE_KEY = "needle-frame:display-code";
const POLL_MS = 1500;

function readInitialCode() {
  if (typeof window === "undefined") return "";
  const fromQuery = new URLSearchParams(window.location.search).get("code");
  if (fromQuery && isDisplayCode(fromQuery)) return normalizeDisplayCode(fromQuery);
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored && isDisplayCode(stored) ? normalizeDisplayCode(stored) : "";
  } catch {
    return "";
  }
}

export default function DisplayPage() {
  const [code, setCode] = useState("");
  const [draft, setDraft] = useState("");
  const [snapshot, setSnapshot] = useState<DisplaySnapshot | null>(null);
  const [error, setError] = useState("");
  const [connected, setConnected] = useState(false);
  const [pending, startTransition] = useTransition();

  const refresh = useEffectEvent(async (sessionCode: string) => {
    try {
      const response = await fetch(`/api/display/state?code=${encodeURIComponent(sessionCode)}`, {
        cache: "no-store",
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        // Expired / unknown saved codes should return to the pairing form, not hang forever.
        if (response.status === 404) {
          try { window.localStorage.removeItem(STORAGE_KEY); } catch { /* optional */ }
          setCode("");
          setDraft("");
          setSnapshot(null);
          setConnected(false);
          setError("That pairing expired. Enter a new code from the controller.");
          return;
        }
        setConnected(false);
        setError(typeof payload.error === "string" ? payload.error : "Display session unavailable.");
        return;
      }
      const next = parseDisplaySnapshot(payload.snapshot);
      if (!next) {
        setConnected(true);
        setSnapshot(createEmptySnapshot({ status: "Connected — waiting for the first presentation." }));
        setError("");
        return;
      }
      setSnapshot(next);
      setConnected(true);
      setError("");
    } catch {
      setConnected(false);
      setError("Lost contact with the controller.");
    }
  });

  useEffect(() => {
    const initial = readInitialCode();
    if (!initial) return;
    setCode(initial);
    setDraft(initial);
  }, []);

  useEffect(() => {
    if (!code) return;
    try { window.localStorage.setItem(STORAGE_KEY, code); } catch { /* optional */ }
    void refresh(code);
    const timer = window.setInterval(() => void refresh(code), POLL_MS);
    return () => window.clearInterval(timer);
  }, [code]);

  function joinSession(event: React.FormEvent) {
    event.preventDefault();
    const next = normalizeDisplayCode(draft);
    if (!isDisplayCode(next)) {
      setError("Enter the six-character code shown on the phone.");
      return;
    }
    startTransition(() => {
      setError("");
      setCode(next);
    });
  }

  function clearPairing() {
    try { window.localStorage.removeItem(STORAGE_KEY); } catch { /* optional */ }
    if (typeof window !== "undefined" && window.history.replaceState) {
      const url = new URL(window.location.href);
      url.searchParams.delete("code");
      window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
    }
    setCode("");
    setDraft("");
    setSnapshot(null);
    setConnected(false);
    setError("");
  }

  if (!code) {
    return (
      <main className="display-pair">
        <p className="eyebrow">Needle & Frame</p>
        <h1>Show on this screen</h1>
        <p>Open the app on your phone, tap Show on TV, then enter the code here.</p>
        <form className="display-pair__form" onSubmit={joinSession}>
          <label>
            <span>Pairing code</span>
            <input
              value={draft}
              onChange={(event) => setDraft(normalizeDisplayCode(event.target.value))}
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              maxLength={6}
              placeholder="AB12CD"
              inputMode="text"
              autoFocus
            />
          </label>
          <button type="submit" disabled={pending || draft.length < 6}>Connect</button>
        </form>
        {error && <p className="display-pair__error" role="alert">{error}</p>}
      </main>
    );
  }

  return (
    <div className="display-shell" data-connected={connected ? "true" : "false"}>
      {!connected && (
        <aside className="display-banner" role="status">
          {error || "Connecting to the controller…"}
        </aside>
      )}
      <PresentationStage
        snapshot={snapshot ?? createEmptySnapshot({ status: "Connected — waiting for the first presentation." })}
        showCurationStatus={false}
      />
      <div className="display-code-chip">
        <span>TV</span>
        <strong aria-label={`Paired with code ${code}`}>{code}</strong>
        <button type="button" onClick={clearPairing}>
          Change code
        </button>
      </div>
    </div>
  );
}
