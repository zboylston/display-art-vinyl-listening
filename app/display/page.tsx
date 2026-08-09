"use client";

import { useEffect, useEffectEvent, useState } from "react";
import { PairingQr } from "../components/pairing-qr";
import { PresentationStage } from "../components/presentation-stage";
import {
  createEmptySnapshot,
  DISPLAY_CODE_STORAGE_KEY,
  isDisplayCode,
  normalizeDisplayCode,
  pairControllerUrl,
  parseDisplaySnapshot,
  type DisplaySnapshot,
} from "../lib/display-snapshot";

const POLL_MS = 1500;

function readStoredCode() {
  if (typeof window === "undefined") return "";
  const fromQuery = new URLSearchParams(window.location.search).get("code");
  if (fromQuery && isDisplayCode(fromQuery)) return normalizeDisplayCode(fromQuery);
  try {
    const stored = window.localStorage.getItem(DISPLAY_CODE_STORAGE_KEY);
    return stored && isDisplayCode(stored) ? normalizeDisplayCode(stored) : "";
  } catch {
    return "";
  }
}

export default function DisplayPage() {
  const [code, setCode] = useState("");
  const [pairUrl, setPairUrl] = useState("");
  const [snapshot, setSnapshot] = useState<DisplaySnapshot | null>(null);
  const [error, setError] = useState("");
  const [connected, setConnected] = useState(false);
  const [controllerLinked, setControllerLinked] = useState(false);
  const [bootstrapping, setBootstrapping] = useState(true);

  const refresh = useEffectEvent(async (sessionCode: string) => {
    try {
      const response = await fetch(`/api/display/state?code=${encodeURIComponent(sessionCode)}`, {
        cache: "no-store",
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        setConnected(false);
        setControllerLinked(false);
        // Session expired — mint a fresh room so the QR stays usable.
        if (response.status === 404) {
          setError("Pairing expired — creating a new code…");
          void createDisplayRoom();
          return;
        }
        setError(typeof payload.error === "string" ? payload.error : "Display session unavailable.");
        return;
      }
      const next = parseDisplaySnapshot(payload.snapshot);
      setConnected(true);
      setError("");
      if (!next) {
        setControllerLinked(false);
        setSnapshot(createEmptySnapshot({ status: "Waiting for your phone to link…" }));
        return;
      }
      setControllerLinked(true);
      setSnapshot(next);
    } catch {
      setConnected(false);
      setError("Lost contact with the pairing service.");
    }
  });

  async function createDisplayRoom(preferred?: string) {
    setBootstrapping(true);
    setError("");
    try {
      const response = await fetch("/api/display/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(preferred ? { code: preferred } : {}),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || typeof payload.code !== "string" || !isDisplayCode(payload.code)) {
        setError(typeof payload.error === "string" ? payload.error : "Could not create a pairing code.");
        setBootstrapping(false);
        return;
      }
      const next = normalizeDisplayCode(payload.code);
      setCode(next);
      setSnapshot(null);
      setControllerLinked(false);
      setConnected(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create a pairing code.");
    } finally {
      setBootstrapping(false);
    }
  }

  useEffect(() => {
    const stored = readStoredCode();
    if (stored) {
      void createDisplayRoom(stored);
      return;
    }
    void createDisplayRoom();
  }, []);

  useEffect(() => {
    if (!code) {
      setPairUrl("");
      return;
    }
    try { window.localStorage.setItem(DISPLAY_CODE_STORAGE_KEY, code); } catch { /* optional */ }
    setPairUrl(pairControllerUrl(window.location.origin, code));
    void refresh(code);
    const timer = window.setInterval(() => void refresh(code), POLL_MS);
    return () => window.clearInterval(timer);
  }, [code]);

  function clearPairing() {
    try { window.localStorage.removeItem(DISPLAY_CODE_STORAGE_KEY); } catch { /* optional */ }
    if (typeof window !== "undefined" && window.history.replaceState) {
      const url = new URL(window.location.href);
      url.searchParams.delete("code");
      window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
    }
    setCode("");
    setPairUrl("");
    setSnapshot(null);
    setConnected(false);
    setControllerLinked(false);
    void createDisplayRoom();
  }

  const waitingForPhone = !controllerLinked;

  if (waitingForPhone) {
    return (
      <main className="display-pair">
        <p className="eyebrow">Needle & Frame</p>
        <h1>Link your phone</h1>
        <p>Open the camera on your phone and scan this code. The phone becomes the listener; this screen shows the art.</p>
        {bootstrapping && !code ? <p className="display-pair__hint">Preparing a pairing code…</p> : null}
        {code && pairUrl ? (
          <div className="display-pair__qr-block">
            <PairingQr url={pairUrl} label={`Scan to link phone with code ${code}`} />
            <p className="display-pair__code" aria-live="polite">{code}</p>
            <p className="display-pair__hint">Or type this code on the phone under Show on TV.</p>
          </div>
        ) : null}
        {error && <p className="display-pair__error" role="alert">{error}</p>}
        {connected && !controllerLinked ? (
          <p className="display-pair__hint">Ready — waiting for the phone to scan…</p>
        ) : null}
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
          Unlink
        </button>
      </div>
    </div>
  );
}
