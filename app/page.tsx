"use client";

import { useEffect, useRef, useState } from "react";
import { PresentationStage } from "./components/presentation-stage";
import { AudioChangeDetector, rmsFromSamples, spectrumBandsFromDb, type DetectorState } from "./lib/audio-change-detector";
import type { DisplaySnapshot } from "./lib/display-snapshot";
import {
  CONTROLLER_CODE_STORAGE_KEY,
  isDisplayCode,
  normalizeDisplayCode,
  sanitizeDisplayStatus,
} from "./lib/display-snapshot";
import { canonicalTrackKey, INITIAL_DISCOVERY_CAPTURE_MS, noMatchRetryDelay, RecognitionGate, textTrackKey } from "./lib/recognition";
import { parseRecentArtworkIds, pushRecentArtworkId, shouldRefreshCachedArtwork } from "./lib/recent-artwork";
import {
  VINYL_END_CONFIRM_GAPLESS_SNAPSHOT_SECONDS,
  VINYL_VERIFY_SNAPSHOT_SECONDS,
  advanceVerificationAt,
  armVinylGapLatch,
  isVinylDetectorStateAudible,
  isVinylGapLatchExpired,
  rollbackAdvanceIndex,
  shouldAdvanceOnGapResume,
  shouldAdvanceOnPrediction,
  shouldArmEndConfirm,
  shouldFireEndConfirm,
  shouldParkVinylOnSilence,
  shouldRollbackUnverifiedAdvance,
  shouldTimeoutEndConfirm,
  silenceFirstAllowsBlindBoundaryAdvance,
  type VinylGapLatch,
} from "./lib/vinyl-advance";
import { planVinylHeartbeats } from "./lib/vinyl-heartbeats";
import { shazamFingerprintDurationMs } from "./lib/recognition/shazam-timing";
import { emptyVinylTimingCalibration, updateVinylTimingCalibration, type VinylTimingCalibration } from "./lib/vinyl-calibration";
import { estimatedRemainingMs, isNearVinylBoundary, planVinylBoundaryAfterIdentify, refinedVinylBoundaryAt, remainingTrackMs, shiftedBoundaryAfterPause, shouldSkipArtworkForRemaining, timecodeAtCaptureMs } from "./lib/vinyl-mode";
import type { VinylProgress } from "./lib/vinyl-folio";
import { encodeMonoWav, prepareRecognitionAudio } from "./lib/wav";

type Act = "ready" | "track" | "handoff" | "art" | "art-fade" | "gallery" | "return";
type ListeningMode = "live" | "vinyl";
type AudioInput = { deviceId: string; label: string };
type Artwork = { id?: string; title: string; artist: string; date: string; museum: string; image: string; rationale: string; brief?: unknown };
type Track = { artist: string; title: string; album: string; year: string; albumCover?: string; isrc?: string; durationMs?: number; timecodeMs?: number; collectionId?: number; trackNumber?: number; discNumber?: number; genre?: string };
type RecognitionReason = "music-started" | "music-resumed" | "spectral-change" | "expected-ending" | "end-confirm" | "safety-check" | "heartbeat" | "pre-transition" | "transition-confirmation" | "legacy-fallback";
type RingSnapshot = { samples: Float32Array; sampleRate: number };
type SnapshotRequest = { resolve: (snapshot: RingSnapshot) => void; reject: (error: Error) => void; timeout: number };
type AudioDebug = { state: DetectorState; score: number; rms: number; reason: string };
type RecognitionPhase = "idle" | "listening" | "suspected" | "checking" | "matched";
type RecognitionOutcome = "match" | "same" | "none" | "error";
type WakeLockSentinelLike = { release: () => Promise<void>; addEventListener?: (type: "release", listener: () => void) => void };

const fixtureTrack: Track = { artist: "Nick Drake", title: "Pink Moon", album: "Pink Moon", year: "1972", albumCover: "https://i.scdn.co/image/ab67616d0000b273e369195caf5d169bf5e9eafc" };
const initialArt: Artwork = { title: "Composition VIII", artist: "Wassily Kandinsky", date: "1923", museum: "Solomon R. Guggenheim Museum", image: "/kandinsky-composition-viii.jpg", rationale: "A study in suspended geometry and rhythmic space." };
const SAMPLE_MS = 9000;
const FEATURE_INTERVAL_MS = 250;
const SNAPSHOT_SECONDS = 15;
const RECOGNITION_COOLDOWN_MS = 15_000;
const NO_MATCH_COOLDOWN_MS = 8_000;
const SAFETY_CHECK_MS = 120_000;
const LEGACY_CHECK_MS = 30_000;
// Leave this switch in place until the detector has been tuned against real-room audio.
const USE_AUDIO_CHANGE_DETECTOR = true;
const TRACK_INFO_MS = 10000;
const INFO_TO_ART_DISSOLVE_MS = 6500;
const ART_INFO_HOLD_MS = 9000;
const ART_INFO_FADE_MS = 3500;
const ART_TO_TRACK_DISSOLVE_MS = 4400;
const CURATION_CACHE_VERSION = "v9-literal-lane";
const RECENT_ARTWORK_STORAGE_KEY = `music-art:recent-artwork:${CURATION_CACHE_VERSION}`;
const EARLY_TRANSITION_CONFIRM_DELAY_MS = 5_000;
/** Brief dropouts should only shift the boundary; longer pauses may mean a skip. */
const MIN_PAUSE_FOR_EARLY_CONFIRM_MS = 3_000;
const MIN_PAUSE_DURING_PRESENTATION_MS = 6_000;
/** Wait this long after the predicted end before sampling so the ring window is
 * mostly the new track; otherwise the verify locks onto the old tail. */
const POST_ADVANCE_VERIFY_BUFFER_MS = 3_000;

function trackKey(track: Track) { return canonicalTrackKey(track); }

function timecodeToMs(timecode?: string): number | undefined {
  if (!timecode) return undefined;
  const parts = timecode.split(":").map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return undefined;
  if (parts.length === 2) return (parts[0] * 60 + parts[1]) * 1000;
  if (parts.length === 3) return (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
  return undefined;
}

function isQuietTimingCheck(reason: RecognitionReason) {
  return reason === "heartbeat" || reason === "pre-transition" || reason === "end-confirm" || reason === "expected-ending";
}

function isPresentationAct(act: Act) {
  return act === "track" || act === "handoff" || act === "art" || act === "art-fade" || act === "gallery" || act === "return";
}

export default function Home() {
  const [act, setAct] = useState<Act>("ready");
  const [currentTrack, setCurrentTrack] = useState<Track>(fixtureTrack);
  const [listeningMode, setListeningMode] = useState<ListeningMode>("live");
  const [artCurationEnabled, setArtCurationEnabled] = useState(true);
  const [vinylProgress, setVinylProgress] = useState<VinylProgress | null>(null);
  const [audioInputs, setAudioInputs] = useState<AudioInput[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState("");
  const [activeMicrophone, setActiveMicrophone] = useState("");
  const [art, setArt] = useState<Artwork>(initialArt);
  const [status, setStatus] = useState("Ready to listen.");
  const [isListening, setIsListening] = useState(false);
  const [showAudioDebug, setShowAudioDebug] = useState(false);
  const [wakeLockState, setWakeLockState] = useState<"on" | "off" | "unsupported">("off");
  const [auddCalls, setAuddCalls] = useState(0);
  const [audioDebug, setAudioDebug] = useState<AudioDebug>({ state: "warming", score: 0, rms: 0, reason: "idle" });
  const [captureDebug, setCaptureDebug] = useState("");
  const [lastSampleUrl, setLastSampleUrl] = useState<string | null>(null);
  const [recognitionPhase, setRecognitionPhase] = useState<RecognitionPhase>("idle");
  const [displayCode, setDisplayCode] = useState("");
  const [displayPairStatus, setDisplayPairStatus] = useState("");
  const [displayCodeDraft, setDisplayCodeDraft] = useState("");
  const currentTrackRef = useRef(currentTrack);
  const actRef = useRef<Act>("ready");
  const listeningModeRef = useRef<ListeningMode>("live");
  const artCurationEnabledRef = useRef(true);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const workletRef = useRef<AudioWorkletNode | null>(null);
  const silentGainRef = useRef<GainNode | null>(null);
  const frequencyDataRef = useRef<Float32Array<ArrayBuffer> | null>(null);
  const waveformDataRef = useRef<Float32Array<ArrayBuffer> | null>(null);
  const monitorIntervalRef = useRef<number | null>(null);
  const wakeLockRef = useRef<WakeLockSentinelLike | null>(null);
  const wakeLockWantedRef = useRef(false);
  const listeningRef = useRef(false);
  const recordingRef = useRef(false);
  const lastTrackKeyRef = useRef("");
  const lastCheckAtRef = useRef(0);
  const nextFallbackAtRef = useRef(0);
  const nextFallbackReasonRef = useRef<RecognitionReason>("safety-check");
  const consecutiveNoMatchRef = useRef(0);
  const lastFeatureAtRef = useRef(0);
  const lastDebugAtRef = useRef(0);
  const detectorRef = useRef(new AudioChangeDetector());
  const recognitionGateRef = useRef(new RecognitionGate());
  const snapshotRequestIdRef = useRef(0);
  const snapshotRequestsRef = useRef(new Map<number, SnapshotRequest>());
  const recognitionPhaseRef = useRef<RecognitionPhase>("idle");
  const phaseTimerRef = useRef<number | null>(null);
  const presentationIdRef = useRef(0);
  const lastSampleUrlRef = useRef<string | null>(null);
  const vinylAlbumRef = useRef<{ tracks: Track[]; index: number } | null>(null);
  const vinylBoundaryAtRef = useRef(0);
  const vinylPauseAtRef = useRef(0);
  const vinylGapPendingRef = useRef(false);
  const vinylGapLatchRef = useRef<VinylGapLatch | null>(null);
  const vinylParkedRef = useRef(false);
  const vinylAdvancePendingVerifyRef = useRef(false);
  const vinylAdvanceInFlightRef = useRef(false);
  const vinylAdvanceStartedAtRef = useRef(0);
  const vinylTimingCalibrationRef = useRef<VinylTimingCalibration>(emptyVinylTimingCalibration());
  const vinylEndConfirmPendingRef = useRef(false);
  const vinylEndConfirmArmedAtRef = useRef(0);
  const vinylEndConfirmInFlightRef = useRef(false);
  /** True when end-confirm armed while music was already playing (gapless). */
  const vinylEndConfirmGaplessRef = useRef(false);
  const vinylLastAdvanceReasonRef = useRef<"gap" | "prediction" | "none">("none");
  const vinylPreloadRef = useRef<{ key: string; promise: Promise<Artwork> } | null>(null);
  const vinylMidpointHeartbeatAtRef = useRef(0);
  const vinylPreTransitionHeartbeatAtRef = useRef(0);
  const vinylEarlyConfirmationTimerRef = useRef<number | null>(null);
  const previousDetectorStateRef = useRef<DetectorState>("warming");
  const hasLiveTrack = currentTrack !== fixtureTrack;

  useEffect(() => { currentTrackRef.current = currentTrack; }, [currentTrack]);
  useEffect(() => { actRef.current = act; }, [act]);
  useEffect(() => { setShowAudioDebug(new URLSearchParams(window.location.search).get("debugAudio") === "1"); }, []);
  useEffect(() => {
    // TV QR encodes /?pair=CODE — scanning opens the phone already linked.
    // Fall back to the last remembered code when there is no scan param.
    let stored: string | null = null;
    try {
      const params = new URLSearchParams(window.location.search);
      const fromScan = params.get("pair") ?? params.get("code");
      if (fromScan && isDisplayCode(fromScan)) {
        const code = normalizeDisplayCode(fromScan);
        void ensureDisplaySession(code);
        if (window.history.replaceState) {
          const url = new URL(window.location.href);
          url.searchParams.delete("pair");
          url.searchParams.delete("code");
          window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
        }
        return;
      }
      stored = window.localStorage.getItem(CONTROLLER_CODE_STORAGE_KEY);
    } catch { /* localStorage optional */ }
    // Reconnect outside the try/catch so a storage read failure can never
    // silently skip re-linking — and surface the attempt so an empty panel
    // is never unexplained.
    if (stored && isDisplayCode(stored)) {
      setDisplayPairStatus("Reconnecting to your TV…");
      void ensureDisplaySession(normalizeDisplayCode(stored));
    }
  }, []);
  useEffect(() => {
    if (!displayCode) return;
    try { window.localStorage.setItem(CONTROLLER_CODE_STORAGE_KEY, displayCode); } catch { /* optional */ }
  }, [displayCode]);
  useEffect(() => {
    // Wake locks auto-release when the tab hides — re-acquire on return.
    const onVisibility = () => {
      if (!document.hidden && listeningRef.current) void acquireWakeLock();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);
  useEffect(() => {
    // Some browsers (iOS Safari) require a user gesture for every wake-lock
    // request, so the visibilitychange re-acquire can fail. Any tap while
    // listening retries it.
    const onTap = () => {
      if (listeningRef.current && !wakeLockRef.current) void acquireWakeLock();
    };
    document.addEventListener("pointerdown", onTap);
    return () => document.removeEventListener("pointerdown", onTap);
  }, []);
  useEffect(() => {
    if (act === "art") { const timer = window.setTimeout(() => setAct("art-fade"), ART_INFO_HOLD_MS); return () => window.clearTimeout(timer); }
    if (act === "art-fade") { const timer = window.setTimeout(() => setAct("gallery"), ART_INFO_FADE_MS); return () => window.clearTimeout(timer); }
  }, [act]);
  useEffect(() => {
    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices?.enumerateDevices) return;
    const refresh = () => void mediaDevices.enumerateDevices().then((devices) => setAudioInputs(devices
      .filter((device) => device.kind === "audioinput")
      .map((device, index) => ({ deviceId: device.deviceId, label: device.label || `Microphone ${index + 1}` })))).catch(() => undefined);
    refresh();
    mediaDevices.addEventListener?.("devicechange", refresh);
    return () => mediaDevices.removeEventListener?.("devicechange", refresh);
  }, []);
  useEffect(() => () => {
    listeningRef.current = false;
    if (monitorIntervalRef.current) window.clearInterval(monitorIntervalRef.current);
    releaseWakeLock();
    streamRef.current?.getTracks().forEach((mediaTrack) => mediaTrack.stop());
    for (const pending of snapshotRequestsRef.current.values()) { window.clearTimeout(pending.timeout); pending.reject(new Error("Listening stopped.")); }
    snapshotRequestsRef.current.clear();
    if (phaseTimerRef.current) window.clearTimeout(phaseTimerRef.current);
    if (lastSampleUrlRef.current) URL.revokeObjectURL(lastSampleUrlRef.current);
    void audioContextRef.current?.close();
  }, []);

  function changeRecognitionPhase(phase: RecognitionPhase) {
    if (recognitionPhaseRef.current === phase) return;
    recognitionPhaseRef.current = phase;
    setRecognitionPhase(phase);
  }

  /** Vinyl album tracks lack ISRC; always compare/cache by artist|title in vinyl mode. */
  function identityKey(track: Track) {
    return listeningModeRef.current === "vinyl" ? textTrackKey(track) : trackKey(track);
  }

  function artworkCacheKey(track: Track) {
    return listeningModeRef.current === "vinyl" ? textTrackKey(track) : trackKey(track);
  }

  /** Keep curation copy on the track screen while background AudD checks run. */
  function shouldAnnounceRecognitionStatus(reason?: RecognitionReason) {
    if (reason && isQuietTimingCheck(reason)) return false;
    if (vinylAlbumRef.current && isPresentationAct(actRef.current)) return false;
    return true;
  }

  function readCachedArtwork(key: string): Artwork | null { try { const value = localStorage.getItem(`music-art:artwork:${CURATION_CACHE_VERSION}:${key}`); return value ? JSON.parse(value) as Artwork : null; } catch { return null; } }
  function cacheArtwork(key: string, artwork: Artwork) { try { localStorage.setItem(`music-art:artwork:${CURATION_CACHE_VERSION}:${key}`, JSON.stringify(artwork)); } catch { /* Cache is optional. */ } }

  function readRecentArtworkIds(): string[] {
    try {
      return parseRecentArtworkIds(JSON.parse(localStorage.getItem(RECENT_ARTWORK_STORAGE_KEY) ?? "[]"));
    } catch {
      return [];
    }
  }

  function rememberArtwork(artwork: Artwork) {
    if (!artwork.id) return;
    try {
      const next = pushRecentArtworkId(readRecentArtworkIds(), artwork.id);
      localStorage.setItem(RECENT_ARTWORK_STORAGE_KEY, JSON.stringify(next));
    } catch { /* History is optional. */ }
  }

  function resolveArtworkCache(key: string): Artwork | null {
    const cached = readCachedArtwork(key);
    if (!cached) return null;
    if (shouldRefreshCachedArtwork(cached.id, readRecentArtworkIds())) return null;
    return cached;
  }

  async function fetchArtwork(track: Track, announce = true): Promise<Artwork> {
    if (announce) setStatus("Curating an artwork for this song…");
    const curateTrack = {
      artist: track.artist,
      title: track.title,
      album: track.album,
      year: track.year,
      ...(track.genre ? { genre: track.genre } : {}),
    };
    const response = await fetch("/api/curate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ track: curateTrack, excludeArtworkIds: readRecentArtworkIds() }),
      signal: AbortSignal.timeout(150000),
    });
    const artwork = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(artwork.error ?? "Artwork selection is unavailable.");
    if (announce) setStatus("Selecting a work from the collection…");
    const image = `/api/art-image?source=${encodeURIComponent(artwork.image)}`;
    const preload = new Image(); preload.src = image; await preload.decode();
    return {
      ...(typeof artwork.id === "string" ? { id: artwork.id } : {}),
      title: artwork.title,
      artist: artwork.artist,
      date: artwork.date,
      museum: artwork.museum,
      image,
      rationale: artwork.rationale,
      ...(artwork.brief ? { brief: artwork.brief } : {}),
    };
  }

  async function presentTrack(track: Track, preparedArtwork?: Artwork) {
    const presentationId = ++presentationIdRef.current;
    const isLeavingArtwork = actRef.current === "art" || actRef.current === "art-fade" || actRef.current === "gallery";
    if (isLeavingArtwork) {
      // Let the previous work resolve into the warm album screen rather than
      // abruptly replacing a finished gallery view with new metadata.
      setAct("return");
      await new Promise<void>((resolve) => window.setTimeout(resolve, ART_TO_TRACK_DISSOLVE_MS));
      if (presentationId !== presentationIdRef.current) return;
    }
    const trackScreenStartedAt = Date.now();
    const key = artworkCacheKey(track);
    setCurrentTrack(track); setAct("track");
    if (!artCurationEnabledRef.current) {
      setStatus(listeningModeRef.current === "vinyl" ? "Vinyl sequence is active — music information only." : "Music information only.");
      return;
    }
    // Mid-song identifies near the ending: skip curation. Fetching art takes
    // longer than the track has left, and the display gets stuck on that work
    // through the start of the next song.
    const remainingMs = estimatedRemainingMs({
      durationMs: track.durationMs,
      timecodeMs: track.timecodeMs,
      boundaryAt: vinylBoundaryAtRef.current,
      now: trackScreenStartedAt,
    });
    if (shouldSkipArtworkForRemaining(remainingMs)) {
      setStatus(
        listeningModeRef.current === "vinyl"
          ? "Near the end of this track — waiting for the next one…"
          : "Near the end of this track — skipping artwork.",
      );
      preloadNextVinylArtwork();
      return;
    }
    const cached = resolveArtworkCache(key);
    const prepared = preparedArtwork && !shouldRefreshCachedArtwork(preparedArtwork.id, readRecentArtworkIds())
      ? preparedArtwork
      : undefined;
    const artwork = prepared ?? cached ?? await fetchArtwork(track);
    if (presentationId !== presentationIdRef.current) return;
    // Advance may have moved the album index (and boundary) before the next
    // presentTrack bumped presentationId — never paint art for a stale track.
    if (identityKey(track) !== lastTrackKeyRef.current) return;
    // Re-check after the (slow) curate round-trip — the song may have ended
    // while we were waiting. Advance the identify-time timecode by wall clock.
    const elapsedOnScreen = Date.now() - trackScreenStartedAt;
    const remainingAfterCurate = estimatedRemainingMs({
      durationMs: track.durationMs,
      timecodeMs: track.timecodeMs !== undefined ? track.timecodeMs + elapsedOnScreen : undefined,
      boundaryAt: vinylBoundaryAtRef.current,
    });
    if (shouldSkipArtworkForRemaining(remainingAfterCurate)) {
      setStatus(
        listeningModeRef.current === "vinyl"
          ? "Near the end of this track — waiting for the next one…"
          : "Near the end of this track — skipping artwork.",
      );
      preloadNextVinylArtwork();
      return;
    }
    cacheArtwork(key, artwork);
    rememberArtwork(artwork);
    setArt(artwork); setStatus("Artwork selected");
    preloadNextVinylArtwork();
    const remainingTrackTime = Math.max(0, TRACK_INFO_MS - (Date.now() - trackScreenStartedAt));
    window.setTimeout(() => {
      if (presentationId !== presentationIdRef.current) return;
      setAct("handoff");
      window.setTimeout(() => { if (presentationId === presentationIdRef.current) setAct("art"); }, INFO_TO_ART_DISSOLVE_MS);
    }, remainingTrackTime);
  }

  function clearVinylEndConfirm() {
    vinylEndConfirmPendingRef.current = false;
    vinylEndConfirmArmedAtRef.current = 0;
    vinylEndConfirmInFlightRef.current = false;
    vinylEndConfirmGaplessRef.current = false;
  }

  function resetVinylPrediction() {
    vinylAlbumRef.current = null;
    vinylBoundaryAtRef.current = 0;
    vinylPauseAtRef.current = 0;
    vinylGapPendingRef.current = false;
    vinylGapLatchRef.current = null;
    vinylParkedRef.current = false;
    vinylAdvancePendingVerifyRef.current = false;
    vinylAdvanceInFlightRef.current = false;
    vinylAdvanceStartedAtRef.current = 0;
    vinylTimingCalibrationRef.current = emptyVinylTimingCalibration();
    vinylLastAdvanceReasonRef.current = "none";
    clearVinylEndConfirm();
    vinylPreloadRef.current = null;
    vinylMidpointHeartbeatAtRef.current = 0;
    vinylPreTransitionHeartbeatAtRef.current = 0;
    if (vinylEarlyConfirmationTimerRef.current) window.clearTimeout(vinylEarlyConfirmationTimerRef.current);
    vinylEarlyConfirmationTimerRef.current = null;
    setVinylProgress(null);
  }

  /** Freeze the predicted sequence until real music returns — do not walk the album index. */
  function parkVinylPlayback() {
    // If we already guessed the next song and silence arrives before verify,
    // undo only a gap-driven guess. A timer prediction already changed the
    // visible track and must never snap backward because verification was late.
    if (
      vinylAdvancePendingVerifyRef.current
      && vinylLastAdvanceReasonRef.current === "gap"
    ) {
      rollbackUnverifiedVinylAdvance();
      return;
    }
    if (vinylLastAdvanceReasonRef.current === "prediction") {
      vinylAdvancePendingVerifyRef.current = false;
      vinylLastAdvanceReasonRef.current = "none";
    }
    vinylGapPendingRef.current = false;
    vinylGapLatchRef.current = null;
    vinylParkedRef.current = true;
    clearVinylEndConfirm();
    if (!vinylPauseAtRef.current) vinylPauseAtRef.current = Date.now();
    vinylMidpointHeartbeatAtRef.current = 0;
    vinylPreTransitionHeartbeatAtRef.current = 0;
    nextFallbackAtRef.current = 0;
    if (shouldAnnounceRecognitionStatus()) setStatus("Waiting for the record to keep playing…");
    setAudioDebug((debug) => ({ ...debug, reason: "park" }));
  }

  /** Undo a predicted advance whose confirm check heard no music. */
  function rollbackUnverifiedVinylAdvance() {
    vinylAdvancePendingVerifyRef.current = false;
    vinylLastAdvanceReasonRef.current = "none";
    clearVinylEndConfirm();
    const album = vinylAlbumRef.current;
    const previousIndex = album ? rollbackAdvanceIndex(album.index) : null;
    if (album && previousIndex !== null) {
      album.index = previousIndex;
      const previous = album.tracks[previousIndex];
      lastTrackKeyRef.current = identityKey(previous);
      updateVinylProgress();
      void presentTrack(previous);
      setStatus("Still on the previous track — waiting for the record…");
    }
    vinylGapPendingRef.current = false;
    vinylGapLatchRef.current = null;
    vinylParkedRef.current = true;
    if (!vinylPauseAtRef.current) vinylPauseAtRef.current = Date.now();
    vinylMidpointHeartbeatAtRef.current = 0;
    vinylPreTransitionHeartbeatAtRef.current = 0;
    nextFallbackAtRef.current = 0;
    setAudioDebug((debug) => ({ ...debug, reason: "rollback+park" }));
  }

  function updateVinylProgress() {
    const album = vinylAlbumRef.current;
    if (!album) { setVinylProgress(null); return; }
    const current = album.tracks[album.index];
    setVinylProgress({ discNumber: current?.discNumber, trackIndex: album.index, totalTracks: album.tracks.length });
  }

  function scheduleVinylHeartbeats() {
    const plan = planVinylHeartbeats(Date.now(), vinylBoundaryAtRef.current);
    vinylMidpointHeartbeatAtRef.current = plan.midpointAt;
    vinylPreTransitionHeartbeatAtRef.current = plan.preTransitionAt;
  }

  function anchorVinylSequence(result: Record<string, unknown>, recognizedTrack: Track, capturedAt: number, sampleDurationMs = 0) {
    if (listeningModeRef.current !== "vinyl" || !Array.isArray(result.albumSequence) || !result.albumSequence.length) return false;
    const tracks = result.albumSequence.filter((item): item is Track => Boolean(item && typeof item === "object" && "artist" in item && "title" in item && "album" in item));
    const suppliedIndex = typeof result.sequenceIndex === "number" ? result.sequenceIndex : -1;
    const matchedIndex = suppliedIndex >= 0 ? suppliedIndex : tracks.findIndex((track) => textTrackKey(track) === textTrackKey(recognizedTrack));
    if (!tracks.length || matchedIndex < 0 || matchedIndex >= tracks.length) return false;
    tracks[matchedIndex] = {
      ...tracks[matchedIndex],
      ...recognizedTrack,
      durationMs: recognizedTrack.durationMs ?? tracks[matchedIndex].durationMs,
      albumCover: recognizedTrack.albumCover ?? tracks[matchedIndex].albumCover,
    };
    vinylAlbumRef.current = { tracks, index: matchedIndex };
    // Provider offset is the song position at the start of the fingerprinted
    // window. Advance to capture end, then account for the request in flight;
    // otherwise every predicted handoff is a clip late.
    const elapsedSinceCapture = Math.min(25_000, Math.max(0, Date.now() - capturedAt));
    const anchoredTimecode = timecodeAtCaptureMs(recognizedTrack.timecodeMs, sampleDurationMs, elapsedSinceCapture);
    tracks[matchedIndex].timecodeMs = anchoredTimecode;
    const now = Date.now();
    const plan = planVinylBoundaryAfterIdentify({
      now,
      durationMs: recognizedTrack.durationMs ?? tracks[matchedIndex].durationMs,
      timecodeMs: anchoredTimecode,
    });
    vinylBoundaryAtRef.current = plan.boundaryAt;
    vinylPauseAtRef.current = 0;
    vinylGapPendingRef.current = false;
    vinylGapLatchRef.current = null;
    vinylParkedRef.current = false;
    clearVinylEndConfirm();
    if (plan.armEndConfirmNow) {
      // Mid-song lock with little time left — don't wait out a soft timer.
      // Start the gapless end-confirm capture immediately so the next track
      // is identified within ~4s + recognition once it starts.
      vinylEndConfirmPendingRef.current = true;
      vinylEndConfirmArmedAtRef.current = now;
      vinylEndConfirmGaplessRef.current = true;
      setAudioDebug((debug) => ({ ...debug, reason: "end-capturing:near-lock" }));
    }
    nextFallbackAtRef.current = 0;
    scheduleVinylHeartbeats();
    updateVinylProgress();
    return true;
  }

  /** Soft-correct the boundary on same-track heartbeats without resetting the album. */
  function refineVinylTiming(recognizedTrack: Track, capturedAt: number, sampleDurationMs = 0) {
    const album = vinylAlbumRef.current;
    if (!album) return;
    const current = album.tracks[album.index];
    if (!current || textTrackKey(current) !== textTrackKey(recognizedTrack)) return;
    const elapsedSinceCapture = Math.min(25_000, Math.max(0, Date.now() - capturedAt));
    const anchoredTimecode = timecodeAtCaptureMs(recognizedTrack.timecodeMs, sampleDurationMs, elapsedSinceCapture);
    if (anchoredTimecode === undefined) return;

    // Calibration sample: the expected-ending verify after a predicted advance.
    // The gap-verify guard already dropped previous-track matches, so this is a
    // clean read on the new track. measuredAhead = how far past the advance
    // Shazam says we are; if the previous boundary was on time, this is 0.
    if (vinylAdvancePendingVerifyRef.current && vinylAdvanceStartedAtRef.current) {
      const measuredAhead = anchoredTimecode - (capturedAt - vinylAdvanceStartedAtRef.current);
      vinylTimingCalibrationRef.current = updateVinylTimingCalibration(
        vinylTimingCalibrationRef.current,
        measuredAhead,
      );
      setAudioDebug((debug) => ({ ...debug, reason: `calibrate:${Math.round(measuredAhead)}ms` }));
    }

    const remaining = remainingTrackMs(recognizedTrack.durationMs ?? current.durationMs, anchoredTimecode);
    if (!remaining) return;
    const proposed = Date.now() + remaining;
    const refined = refinedVinylBoundaryAt(vinylBoundaryAtRef.current, proposed);
    if (refined === vinylBoundaryAtRef.current) return;
    current.timecodeMs = anchoredTimecode;
    if (recognizedTrack.durationMs) current.durationMs = recognizedTrack.durationMs;
    vinylBoundaryAtRef.current = refined;
    scheduleVinylHeartbeats();
  }

  function preloadNextVinylArtwork() {
    if (!artCurationEnabledRef.current) return;
    const album = vinylAlbumRef.current;
    const next = album?.tracks[album.index + 1];
    if (!next) { vinylPreloadRef.current = null; return; }
    const key = artworkCacheKey(next);
    if (vinylPreloadRef.current?.key === key) return;
    const cached = resolveArtworkCache(key);
    const promise = cached ? Promise.resolve(cached) : fetchArtwork(next, false).then((artwork) => {
      cacheArtwork(key, artwork);
      return artwork;
    });
    vinylPreloadRef.current = { key, promise };
    void promise.catch(() => {
      if (vinylPreloadRef.current?.key === key) vinylPreloadRef.current = null;
    });
  }

  async function advanceVinyl(reason: "gap" | "prediction") {
    const album = vinylAlbumRef.current;
    if (!album || vinylAdvanceInFlightRef.current) return false;
    const nextIndex = album.index + 1;
    const next = album.tracks[nextIndex];
    if (!next) {
      vinylBoundaryAtRef.current = 0;
      vinylMidpointHeartbeatAtRef.current = 0;
      vinylPreTransitionHeartbeatAtRef.current = 0;
      clearVinylEndConfirm();
      setVinylProgress(null);
      setStatus("The album sequence is complete — listening for the next record.");
      return false;
    }
    vinylAdvanceInFlightRef.current = true;
    album.index = nextIndex;
    next.timecodeMs = 0;
    const advanceStartedAt = Date.now();
    vinylAdvanceStartedAtRef.current = advanceStartedAt;
    const calibratedDurationMs = next.durationMs ? Math.max(0, next.durationMs - vinylTimingCalibrationRef.current.offsetMs) : 0;
    vinylBoundaryAtRef.current = calibratedDurationMs ? advanceStartedAt + calibratedDurationMs : 0;
    vinylPauseAtRef.current = 0;
    vinylGapPendingRef.current = false;
    vinylGapLatchRef.current = null;
    vinylParkedRef.current = false;
    clearVinylEndConfirm();
    if (vinylEarlyConfirmationTimerRef.current) window.clearTimeout(vinylEarlyConfirmationTimerRef.current);
    vinylEarlyConfirmationTimerRef.current = null;
    scheduleVinylHeartbeats();
    lastTrackKeyRef.current = identityKey(next);
    updateVinylProgress();
    changeRecognitionPhase("matched");
    if (phaseTimerRef.current) window.clearTimeout(phaseTimerRef.current);
    phaseTimerRef.current = window.setTimeout(() => changeRecognitionPhase("listening"), 2_800);
    // The visible handoff happens now. Recognition verifies/re-anchors later;
    // a miss must never block or undo a prediction-driven transition.
    vinylAdvancePendingVerifyRef.current = true;
    vinylLastAdvanceReasonRef.current = reason;
    nextFallbackAtRef.current = advanceVerificationAt(Date.now() + POST_ADVANCE_VERIFY_BUFFER_MS);
    nextFallbackReasonRef.current = "expected-ending";
    setAudioDebug((debug) => ({ ...debug, reason: `advance:${reason}` }));
    try {
      const preload = vinylPreloadRef.current?.key === artworkCacheKey(next) ? vinylPreloadRef.current.promise : undefined;
      const prepared = preload ? await preload.catch(() => undefined) : undefined;
      vinylPreloadRef.current = null;
      await presentTrack(next, prepared);
      return true;
    } finally {
      vinylAdvanceInFlightRef.current = false;
    }
  }

  function scheduleFallbackForTrack(track: Track) {
    const now = Date.now();
    const remaining = track.durationMs && track.timecodeMs !== undefined ? track.durationMs - track.timecodeMs : undefined;
    const delay = remaining && remaining > 0 ? Math.min(SAFETY_CHECK_MS, Math.max(30_000, remaining + 2_500)) : SAFETY_CHECK_MS;
    nextFallbackAtRef.current = now + delay;
    nextFallbackReasonRef.current = delay < SAFETY_CHECK_MS ? "expected-ending" : "safety-check";
  }

  async function identifyRecording(audio: Blob, capturedAt = Date.now(), reason?: RecognitionReason, sampleDurationMs = 0): Promise<RecognitionOutcome> {
    try {
      if (shouldAnnounceRecognitionStatus(reason)) setStatus("Identifying the music…");
      setAuddCalls((count) => count + 1);
      const extension = audio.type.includes("wav") ? "wav" : audio.type.includes("mp4") ? "m4a" : "webm";
      const form = new FormData(); form.append("audio", audio, `capture.${extension}`); form.append("mode", listeningModeRef.current);
      const response = await fetch("/api/recognize", { method: "POST", body: form, signal: AbortSignal.timeout(40000) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (shouldAnnounceRecognitionStatus(reason)) setStatus(`Recognition error ${response.status}: ${data.error ?? "Unknown response"}`);
        return "error";
      }
      if (!data.result) {
        if (shouldAnnounceRecognitionStatus(reason)) {
          setStatus(
            typeof data.warning === "string"
              ? data.warning
              : listeningRef.current ? "No confident match yet — still listening…" : "No match found.",
          );
        }
        return "none";
      }
      const track: Track = {
        artist: data.result.artist ?? "Unknown artist",
        title: data.result.title ?? "Unknown track",
        album: data.result.album ?? "Album unknown",
        year: (data.result.releaseDate ?? "").slice(0, 4),
        albumCover: data.result.albumCover,
        isrc: data.result.isrc,
        durationMs: data.result.durationMs,
        timecodeMs: typeof data.result.timecodeMs === "number" ? data.result.timecodeMs : timecodeToMs(data.result.timecode),
        collectionId: data.result.collectionId,
        trackNumber: data.result.trackNumber,
        discNumber: data.result.discNumber,
        genre: typeof data.result.genre === "string" ? data.result.genre : undefined,
      };
      // Shazam fingerprints only the trailing ≤12s of the upload; advancing by
      // the full clip length would place every boundary several seconds early.
      const timingSampleMs = data.provider === "shazam"
        ? shazamFingerprintDurationMs(sampleDurationMs)
        : sampleDurationMs;
      const key = identityKey(track);
      if (key === lastTrackKeyRef.current) {
        // Same song: refine timing without a full re-anchor, and never overwrite
        // curation status on the track screen.
        if (vinylAlbumRef.current) {
          refineVinylTiming(track, capturedAt, timingSampleMs);
          preloadNextVinylArtwork();
        } else {
          if (shouldAnnounceRecognitionStatus(reason)) setStatus("Still listening…");
        }
        return "same";
      }
      // Gap-verify guard: right after an optimistic advance, the verify clip can
      // still hold the previous track's tail. If AudD locks onto that previous
      // song, do NOT re-anchor backward — that is the advance-then-revert
      // ping-pong. Treat it as a stale read and keep the advance.
      const album = vinylAlbumRef.current;
      if (vinylAdvancePendingVerifyRef.current && album) {
        const previousIndex = album.index - 1;
        const previous = previousIndex >= 0 ? album.tracks[previousIndex] : undefined;
        if (previous && textTrackKey(previous) === textTrackKey(track)) {
          return "same";
        }
      }
      const vinylAnchored = anchorVinylSequence(data.result as Record<string, unknown>, track, capturedAt, timingSampleMs);
      if (!vinylAnchored) scheduleFallbackForTrack(track);
      lastTrackKeyRef.current = key;
      const presentation = presentTrack(track);
      void presentation.catch((error) => setStatus(error instanceof Error ? error.message : "Artwork selection is unavailable."));
      return "match";
    } catch (error) {
      if (shouldAnnounceRecognitionStatus(reason)) setStatus(error instanceof Error ? error.message : "Music identification failed.");
      return "none";
    }
  }

  function takeRingSnapshot(seconds = SNAPSHOT_SECONDS): Promise<RingSnapshot> {
    const worklet = workletRef.current;
    if (!worklet) return Promise.reject(new Error("Audio ring buffer is unavailable."));
    const requestId = ++snapshotRequestIdRef.current;
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        snapshotRequestsRef.current.delete(requestId);
        reject(new Error("Audio snapshot timed out."));
      }, 2_000);
      snapshotRequestsRef.current.set(requestId, { resolve, reject, timeout });
      worklet.port.postMessage({ type: "snapshot", requestId, seconds });
    });
  }

  function finishRecognition(outcome: RecognitionOutcome, reason: RecognitionReason) {
    const now = Date.now();
    const cooldown = outcome === "none" || outcome === "error" ? NO_MATCH_COOLDOWN_MS : RECOGNITION_COOLDOWN_MS;
    recognitionGateRef.current.finish(now, cooldown);
    detectorRef.current.markRecognition(now, cooldown);
    detectorRef.current.resetHistory(now);
    if (reason === "end-confirm") {
      vinylEndConfirmInFlightRef.current = false;
      clearVinylEndConfirm();
      if (outcome === "none" || outcome === "error") {
        parkVinylPlayback();
        consecutiveNoMatchRef.current += 1;
      } else {
        consecutiveNoMatchRef.current = 0;
        vinylParkedRef.current = false;
        // If refine rejected a large correction, the boundary can still be in the
        // past and we'd immediately re-arm end-confirm — nudge it forward.
        if (outcome === "same" && vinylBoundaryAtRef.current <= now) {
          vinylBoundaryAtRef.current = now + 30_000;
          scheduleVinylHeartbeats();
        }
      }
    } else if (shouldRollbackUnverifiedAdvance({
      pendingVerify: vinylAdvancePendingVerifyRef.current,
      outcome,
      advanceReason: vinylLastAdvanceReasonRef.current,
    })) {
      rollbackUnverifiedVinylAdvance();
      consecutiveNoMatchRef.current += 1;
    } else if (outcome === "none" || outcome === "error") {
      // Prediction already changed the visible track. A failed background check
      // is inconclusive, not grounds to revert or block the next boundary.
      if (
        vinylAdvancePendingVerifyRef.current
        && vinylLastAdvanceReasonRef.current === "prediction"
      ) {
        vinylAdvancePendingVerifyRef.current = false;
        vinylLastAdvanceReasonRef.current = "none";
      }
      consecutiveNoMatchRef.current += 1;
      const retryDelay = noMatchRetryDelay(Boolean(lastTrackKeyRef.current), consecutiveNoMatchRef.current, SAFETY_CHECK_MS);
      nextFallbackAtRef.current = now + retryDelay;
      nextFallbackReasonRef.current = "safety-check";
    } else {
      consecutiveNoMatchRef.current = 0;
      // A heartbeat started before the timer advance can finish afterward and
      // hear the old track. Keep the prediction verify pending until its own
      // expected-ending check runs.
      const stalePreAdvanceCheck = (
        vinylAdvancePendingVerifyRef.current
        && vinylLastAdvanceReasonRef.current === "prediction"
        && reason !== "expected-ending"
      );
      if (!stalePreAdvanceCheck) {
        vinylAdvancePendingVerifyRef.current = false;
        vinylLastAdvanceReasonRef.current = "none";
      }
    }
    setAudioDebug((debug) => ({ ...debug, reason: `${reason}:${outcome}` }));
    if (phaseTimerRef.current) window.clearTimeout(phaseTimerRef.current);
    if (outcome === "match" && listeningModeRef.current === "vinyl" && vinylAlbumRef.current) {
      // Once a record has been identified, Vinyl Mode should feel settled.
      // The microphone remains available for the next predicted boundary, but
      // we deliberately hide the active-listening phase during presentation.
      changeRecognitionPhase("idle");
    } else if (outcome === "same" && listeningModeRef.current === "vinyl" && vinylAlbumRef.current) {
      changeRecognitionPhase("idle");
    } else if (outcome === "match") {
      changeRecognitionPhase("matched");
      phaseTimerRef.current = window.setTimeout(() => changeRecognitionPhase("listening"), 2_800);
    } else changeRecognitionPhase("listening");
  }

  function captureLegacySample(reason: RecognitionReason) {
    if (!listeningRef.current || recordingRef.current || !streamRef.current) { recognitionGateRef.current.cancel(); return; }
    recordingRef.current = true;
    const preferredType = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((type) => MediaRecorder.isTypeSupported(type));
    const recorder = preferredType ? new MediaRecorder(streamRef.current, { mimeType: preferredType, audioBitsPerSecond: 128000 }) : new MediaRecorder(streamRef.current);
    const chunks: BlobPart[] = [];
    recorder.ondataavailable = (event) => chunks.push(event.data);
    recorder.onstop = () => {
      recordingRef.current = false;
      if (!chunks.length) { recognitionGateRef.current.cancel(); return; }
      void identifyRecording(new Blob(chunks, { type: recorder.mimeType || "audio/webm" }), Date.now(), reason, SAMPLE_MS).then((outcome) => finishRecognition(outcome, reason));
    };
    recorder.start();
    if (shouldAnnounceRecognitionStatus(reason)) setStatus("Listening to confirm the song…");
    window.setTimeout(() => { if (recorder.state === "recording") recorder.stop(); }, SAMPLE_MS);
  }

  async function requestRecognition(reason: RecognitionReason) {
    const now = Date.now();
    if (!listeningRef.current || !recognitionGateRef.current.tryStart(now)) {
      if (reason === "end-confirm") vinylEndConfirmInFlightRef.current = false;
      if (reason === "expected-ending" && vinylAdvancePendingVerifyRef.current) {
        // A pre-transition heartbeat may still own the recognition gate. Retry
        // promptly instead of losing verification for the next two minutes.
        nextFallbackAtRef.current = now + 2_000;
        nextFallbackReasonRef.current = "expected-ending";
      }
      return;
    }
    lastCheckAtRef.current = now;
    detectorRef.current.markRecognition(now, RECOGNITION_COOLDOWN_MS);
    changeRecognitionPhase("checking");
    setAudioDebug((debug) => ({ ...debug, reason }));
    if (!workletRef.current) { captureLegacySample("legacy-fallback"); return; }
    try {
      if (shouldAnnounceRecognitionStatus(reason)) setStatus("Checking the song…");
      // After a real gap, exclude the preceding track from the upload. Five
      // post-gap seconds are enough for AudD and avoid a mixed-song sample.
      const vinylDiscovery = listeningModeRef.current === "vinyl" && !lastTrackKeyRef.current;
      const discoveryRetry = vinylDiscovery && consecutiveNoMatchRef.current > 0;
      // Vinyl first-lock needs a long, EQ'd room capture; digital streams usually match on 15s.
      const vinylDiscoverySeconds = 24;
      const snapshotSeconds = reason === "transition-confirmation"
        ? 10
        : reason === "music-resumed"
          ? 5
          : reason === "end-confirm" && vinylEndConfirmGaplessRef.current
            ? VINYL_END_CONFIRM_GAPLESS_SNAPSHOT_SECONDS
            : reason === "expected-ending" || reason === "end-confirm"
              ? VINYL_VERIFY_SNAPSHOT_SECONDS
              : vinylDiscovery
                ? vinylDiscoverySeconds
                : SNAPSHOT_SECONDS;
      const snapshot = await takeRingSnapshot(snapshotSeconds);
      const capturedAt = Date.now();
      if (snapshot.samples.length < snapshot.sampleRate * 4) throw new Error("Waiting for a longer music sample.");
      const prepared = prepareRecognitionAudio(
        snapshot.samples,
        snapshot.sampleRate,
        vinylDiscovery,
        vinylDiscovery ? 0.14 : 0.12,
        vinylDiscovery ? 18 : 12,
      );
      const audio = encodeMonoWav(prepared.samples, snapshot.sampleRate);
      setCaptureDebug(`clip ${(prepared.samples.length / snapshot.sampleRate).toFixed(1)}s${prepared.conditioned ? " · EQ" : ""}${discoveryRetry ? " · retry" : ""} · in ${prepared.inputRms.toFixed(3)} · gain ${prepared.gain.toFixed(1)}× · out ${prepared.outputRms.toFixed(3)}`);
      if (showAudioDebug) {
        if (lastSampleUrlRef.current) URL.revokeObjectURL(lastSampleUrlRef.current);
        const sampleUrl = URL.createObjectURL(audio);
        lastSampleUrlRef.current = sampleUrl;
        setLastSampleUrl(sampleUrl);
      }
      const outcome = await identifyRecording(audio, capturedAt, reason, (prepared.samples.length / snapshot.sampleRate) * 1000);
      finishRecognition(outcome, reason);
    } catch (error) {
      if (reason === "end-confirm") {
        vinylEndConfirmInFlightRef.current = false;
        clearVinylEndConfirm();
        parkVinylPlayback();
      }
      recognitionGateRef.current.finish(Date.now(), NO_MATCH_COOLDOWN_MS);
      detectorRef.current.markRecognition(Date.now(), NO_MATCH_COOLDOWN_MS);
      nextFallbackAtRef.current = Date.now() + 10_000;
      changeRecognitionPhase("listening");
      if (shouldAnnounceRecognitionStatus(reason)) setStatus(error instanceof Error ? error.message : "Music identification failed.");
    }
  }

  function monitorSound() {
    if (!listeningRef.current || !analyserRef.current) return;
    const now = performance.now();
    if (now - lastFeatureAtRef.current >= FEATURE_INTERVAL_MS) {
      lastFeatureAtRef.current = now;
      const analyser = analyserRef.current;
      const frequency = frequencyDataRef.current;
      const waveform = waveformDataRef.current;
      if (frequency && waveform) {
        analyser.getFloatFrequencyData(frequency);
        analyser.getFloatTimeDomainData(waveform);
        const update = detectorRef.current.push({
          at: Date.now(),
          spectrum: spectrumBandsFromDb(frequency, audioContextRef.current?.sampleRate ?? 48_000, analyser.fftSize),
          rms: rmsFromSamples(waveform),
        });
        const vinylMode = listeningModeRef.current === "vinyl";
        const predictiveVinyl = vinylMode && Boolean(vinylAlbumRef.current);
        const vinylHasNext = Boolean(vinylAlbumRef.current?.tracks[(vinylAlbumRef.current?.index ?? -1) + 1]);
        const wallNow = Date.now();
        const nearPredictedBoundary = predictiveVinyl && isNearVinylBoundary(vinylBoundaryAtRef.current, wallNow);
        if (now - lastDebugAtRef.current >= 1_000) {
          lastDebugAtRef.current = now;
          setAudioDebug((debug) => ({ ...debug, state: update.state, score: update.score, rms: update.rms }));
        }
        if ((!predictiveVinyl || nearPredictedBoundary) && (update.state === "resuming" || update.state === "suspected") && recognitionPhaseRef.current === "listening") {
          changeRecognitionPhase("suspected");
          if (shouldAnnounceRecognitionStatus()) setStatus("Possible new song — listening for a moment…");
        } else if ((predictiveVinyl && !nearPredictedBoundary || update.state === "stable" || update.state === "warming") && recognitionPhaseRef.current === "suspected") {
          changeRecognitionPhase("listening");
          if (shouldAnnounceRecognitionStatus()) setStatus("Still listening…");
        }
        if (vinylMode && update.event === "silence" && vinylAlbumRef.current) {
          if (isNearVinylBoundary(vinylBoundaryAtRef.current, wallNow) && !vinylParkedRef.current) {
            vinylGapPendingRef.current = true;
            vinylGapLatchRef.current = armVinylGapLatch(wallNow);
            clearVinylEndConfirm();
            // Freeze the timer clock too — otherwise ambient noise can satisfy
            // state !== "silence" and walk the album after the record stops.
            if (!vinylPauseAtRef.current) vinylPauseAtRef.current = wallNow;
            if (shouldAnnounceRecognitionStatus()) setStatus("Preparing next track…");
            setAudioDebug((debug) => ({ ...debug, reason: "arm-gap" }));
          } else {
            vinylPauseAtRef.current = wallNow;
          }
        }
        if (vinylMode && vinylAlbumRef.current) {
          if (vinylGapPendingRef.current && isVinylGapLatchExpired(vinylGapLatchRef.current, wallNow)) {
            // Near-boundary silence never became real music — park instead of advancing on noise.
            parkVinylPlayback();
          } else if (
            vinylPauseAtRef.current
            && !vinylGapPendingRef.current
            && !vinylParkedRef.current
            && shouldParkVinylOnSilence(vinylPauseAtRef.current, wallNow)
          ) {
            parkVinylPlayback();
          }
        }
        if (vinylMode && previousDetectorStateRef.current === "silence" && update.state === "resuming") {
          // Do not advance here — the first resuming frame is too easy to trip with
          // room noise. Gap advances wait for confirmed music-resumed below.
          if (!vinylGapPendingRef.current && vinylPauseAtRef.current) {
            const pauseStartedAt = vinylPauseAtRef.current;
            vinylPauseAtRef.current = 0;
            const pauseMs = wallNow - pauseStartedAt;
            const minPauseMs = isPresentationAct(actRef.current)
              ? MIN_PAUSE_DURING_PRESENTATION_MS
              : MIN_PAUSE_FOR_EARLY_CONFIRM_MS;
            // Brief room-level dropouts only shift the boundary. A sustained
            // pause far from the predicted ending may mean a skip — confirm
            // after a short clean fingerprint window.
            if (
              pauseMs >= minPauseMs
              && !isNearVinylBoundary(vinylBoundaryAtRef.current, wallNow)
              && !vinylEarlyConfirmationTimerRef.current
            ) {
              vinylEarlyConfirmationTimerRef.current = window.setTimeout(() => {
                vinylEarlyConfirmationTimerRef.current = null;
                void requestRecognition("transition-confirmation");
              }, EARLY_TRANSITION_CONFIRM_DELAY_MS);
            } else {
              vinylBoundaryAtRef.current = shiftedBoundaryAfterPause(vinylBoundaryAtRef.current, pauseStartedAt, wallNow);
              vinylParkedRef.current = false;
              scheduleVinylHeartbeats();
            }
          }
        }
        if (USE_AUDIO_CHANGE_DETECTOR && update.event === "music-started") void requestRecognition("music-started");
        if (USE_AUDIO_CHANGE_DETECTOR && update.event === "music-resumed") {
          if (shouldAdvanceOnGapResume(vinylGapPendingRef.current, update.event)) {
            void advanceVinyl("gap");
          } else if (vinylEndConfirmPendingRef.current) {
            // End timer already fired; start the audible capture clock once (don't reset on flaps).
            if (!vinylEndConfirmArmedAtRef.current) vinylEndConfirmArmedAtRef.current = wallNow;
            vinylEndConfirmGaplessRef.current = false;
            vinylParkedRef.current = false;
            vinylPauseAtRef.current = 0;
            setAudioDebug((debug) => ({ ...debug, reason: "end-capturing" }));
          } else if (vinylMode && vinylParkedRef.current) {
            vinylParkedRef.current = false;
            vinylPauseAtRef.current = 0;
            void requestRecognition("transition-confirmation");
          } else if (!predictiveVinyl || !vinylHasNext) {
            void requestRecognition("music-resumed");
          }
        }
        if (USE_AUDIO_CHANGE_DETECTOR && update.event === "change-suspected") {
          // Live mode still uses spectral change. Vinyl silence-first ignores it for advances.
          if (!vinylMode || !vinylAlbumRef.current) void requestRecognition("spectral-change");
        }
        if (vinylMode && vinylAlbumRef.current && vinylBoundaryAtRef.current > 0) {
          const pastBoundary = wallNow >= vinylBoundaryAtRef.current;
          const audible = isVinylDetectorStateAudible(update.state);

          if (
            shouldAdvanceOnPrediction({
              pastBoundary,
              parked: vinylParkedRef.current,
              pendingVerify: vinylAdvancePendingVerifyRef.current,
              advanceInFlight: vinylAdvanceInFlightRef.current,
              endConfirmInFlight: vinylEndConfirmInFlightRef.current,
            })
          ) {
            // The album sequence is already known: change the visible track at
            // zero, including during a short inter-track silence. Recognition
            // verifies in the background and cannot block or undo the handoff.
            void advanceVinyl("prediction");
            // If the record is truly stopped rather than between tracks, retain
            // a silence clock so sustained-silence parking still activates.
            if (!audible) vinylPauseAtRef.current = wallNow;
          } else if (
            shouldTimeoutEndConfirm({
              endConfirmPending: vinylEndConfirmPendingRef.current,
              endConfirmArmedAt: vinylEndConfirmArmedAtRef.current,
              boundaryAt: vinylBoundaryAtRef.current,
              now: wallNow,
              audible,
            })
          ) {
            parkVinylPlayback();
          } else if (
            shouldFireEndConfirm({
              endConfirmPending: vinylEndConfirmPendingRef.current,
              endConfirmArmedAt: vinylEndConfirmArmedAtRef.current,
              now: wallNow,
              audible,
              gapless: vinylEndConfirmGaplessRef.current,
            })
            && !vinylEndConfirmInFlightRef.current
            && !vinylAdvanceInFlightRef.current
          ) {
            vinylEndConfirmInFlightRef.current = true;
            setAudioDebug((debug) => ({ ...debug, reason: "end-confirm" }));
            void requestRecognition("end-confirm");
          } else if (
            shouldArmEndConfirm({
              pastBoundary,
              parked: vinylParkedRef.current,
              gapPending: vinylGapPendingRef.current,
              pendingVerify: vinylAdvancePendingVerifyRef.current,
              endConfirmPending: vinylEndConfirmPendingRef.current,
            })
            && !silenceFirstAllowsBlindBoundaryAdvance()
          ) {
            vinylEndConfirmPendingRef.current = true;
            vinylEndConfirmArmedAtRef.current = audible ? wallNow : 0;
            vinylEndConfirmGaplessRef.current = audible;
            setAudioDebug((debug) => ({ ...debug, reason: audible ? "end-capturing" : "end-waiting" }));
          }
        }
        if (predictiveVinyl && !vinylAdvanceInFlightRef.current) {
          if (vinylMidpointHeartbeatAtRef.current > 0 && wallNow >= vinylMidpointHeartbeatAtRef.current) {
            vinylMidpointHeartbeatAtRef.current = 0;
            void requestRecognition("heartbeat");
          } else if (vinylPreTransitionHeartbeatAtRef.current > 0 && wallNow >= vinylPreTransitionHeartbeatAtRef.current) {
            vinylPreTransitionHeartbeatAtRef.current = 0;
            void requestRecognition("pre-transition");
          }
        }
        previousDetectorStateRef.current = update.state;
      }
      const wallNow = Date.now();
      if (nextFallbackAtRef.current > 0 && wallNow >= nextFallbackAtRef.current) {
        nextFallbackAtRef.current = wallNow + SAFETY_CHECK_MS;
        void requestRecognition(nextFallbackReasonRef.current);
      } else if (!USE_AUDIO_CHANGE_DETECTOR && wallNow - lastCheckAtRef.current >= LEGACY_CHECK_MS) void requestRecognition("legacy-fallback");
    }
  }

  /**
   * Screen Wake Lock keeps the controller phone awake while listening — the
   * whole detection pipeline dies if the screen locks or the tab suspends.
   * Browsers require a fresh user gesture for each request, so this must be
   * called synchronously from the Listen tap (before any await) — by the time
   * the mic permission prompt is answered, the gesture has expired and the
   * request is silently rejected. Wake locks also auto-release when the tab
   * hides, so re-acquire on visibility return and on any later tap.
   */
  async function acquireWakeLock() {
    const wakeLock = (navigator as Navigator & { wakeLock?: { request: (type: "screen") => Promise<WakeLockSentinelLike> } }).wakeLock;
    if (!wakeLock) { setWakeLockState("unsupported"); return; }
    if (wakeLockRef.current) return;
    wakeLockWantedRef.current = true;
    try {
      const sentinel = await wakeLock.request("screen");
      if (!wakeLockWantedRef.current) { void sentinel.release().catch(() => undefined); return; }
      wakeLockRef.current = sentinel;
      setWakeLockState("on");
      sentinel.addEventListener?.("release", () => {
        if (wakeLockRef.current === sentinel) wakeLockRef.current = null;
        setWakeLockState("off");
      });
    } catch {
      wakeLockRef.current = null;
      setWakeLockState("off");
      if (listeningRef.current) setStatus("Listening — keep this screen awake so detection keeps running.");
    }
  }

  function releaseWakeLock() {
    wakeLockWantedRef.current = false;
    const sentinel = wakeLockRef.current;
    wakeLockRef.current = null;
    setWakeLockState("off");
    void sentinel?.release().catch(() => undefined);
  }

  async function startListenMode() {
    if (listeningRef.current) return;
    // Request the wake lock first, synchronously inside the tap gesture —
    // after the awaits below (mic prompt, AudioContext) the gesture has
    // expired and browsers silently reject the request.
    void acquireWakeLock();
    try {
      if (!window.isSecureContext) {
        releaseWakeLock();
        setStatus("Microphone needs HTTPS or localhost. Use this computer as the controller (localhost:3000); keep the phone/TV on /display only.");
        return;
      }
      if (!navigator.mediaDevices?.getUserMedia) {
        releaseWakeLock();
        setStatus("This browser cannot access the microphone.");
        return;
      }
      if (listeningModeRef.current === "vinyl") {
        resetVinylPrediction();
        lastTrackKeyRef.current = "";
      }
      setStatus("Requesting microphone access…");
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: selectedDeviceId ? { exact: selectedDeviceId } : undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: true, channelCount: 1, sampleRate: 48_000 },
      });
      const microphoneTrack = stream.getAudioTracks()[0];
      setActiveMicrophone(microphoneTrack?.label ?? "Default microphone");
      const actualDeviceId = microphoneTrack?.getSettings().deviceId;
      if (actualDeviceId) setSelectedDeviceId(actualDeviceId);
      void navigator.mediaDevices.enumerateDevices().then((devices) => setAudioInputs(devices
        .filter((device) => device.kind === "audioinput")
        .map((device, index) => ({ deviceId: device.deviceId, label: device.label || `Microphone ${index + 1}` })))).catch(() => undefined);
      const context = new AudioContext(); await context.resume();
      const analyser = context.createAnalyser(); analyser.fftSize = 2048; analyser.smoothingTimeConstant = 0.35;
      const source = context.createMediaStreamSource(stream); source.connect(analyser);
      let worklet: AudioWorkletNode | null = null;
      let silentGain: GainNode | null = null;
      try {
        await context.audioWorklet.addModule("/audio-ring-buffer-worklet.js?v=24s-eq");
        worklet = new AudioWorkletNode(context, "audio-ring-buffer", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
        silentGain = context.createGain(); silentGain.gain.value = 0;
        source.connect(worklet); worklet.connect(silentGain); silentGain.connect(context.destination);
        worklet.port.onmessage = (event: MessageEvent<{ type?: string; requestId?: number; sampleRate?: number; samples?: ArrayBuffer }>) => {
          const message = event.data;
          if (message.type !== "snapshot" || message.requestId === undefined || !message.samples || !message.sampleRate) return;
          const pending = snapshotRequestsRef.current.get(message.requestId);
          if (!pending) return;
          window.clearTimeout(pending.timeout); snapshotRequestsRef.current.delete(message.requestId);
          pending.resolve({ samples: new Float32Array(message.samples), sampleRate: message.sampleRate });
        };
      } catch (error) { console.warn("Audio ring buffer unavailable; using MediaRecorder fallback.", error); }
      streamRef.current = stream; audioContextRef.current = context; analyserRef.current = analyser;
      workletRef.current = worklet; silentGainRef.current = silentGain;
      frequencyDataRef.current = new Float32Array(analyser.frequencyBinCount);
      waveformDataRef.current = new Float32Array(analyser.fftSize);
      detectorRef.current = new AudioChangeDetector(); recognitionGateRef.current = new RecognitionGate();
      previousDetectorStateRef.current = "warming";
      lastFeatureAtRef.current = 0; lastCheckAtRef.current = Date.now();
      nextFallbackAtRef.current = Date.now() + (lastTrackKeyRef.current ? SAFETY_CHECK_MS : INITIAL_DISCOVERY_CAPTURE_MS);
      consecutiveNoMatchRef.current = 0; listeningRef.current = true; setIsListening(true);
      changeRecognitionPhase("listening");
      setStatus(worklet
        ? listeningModeRef.current === "vinyl" ? "Vinyl mode is listening — identifying the record…" : "Listen mode is on — learning the sound…"
        : "Listen mode is on — compatibility capture enabled…");
      if (!worklet || !USE_AUDIO_CHANGE_DETECTOR) window.setTimeout(() => void requestRecognition("legacy-fallback"), 1_000);
      // Interval-driven, not rAF: requestAnimationFrame stops when the tab
      // backgrounds; setInterval throttles to ~1s but keeps detection alive.
      if (monitorIntervalRef.current) window.clearInterval(monitorIntervalRef.current);
      monitorIntervalRef.current = window.setInterval(monitorSound, FEATURE_INTERVAL_MS);
      monitorSound();
    } catch (error) {
      releaseWakeLock();
      const name = error instanceof DOMException ? error.name : "";
      if (name === "NotAllowedError" || name === "PermissionDeniedError") {
        setStatus("Microphone permission was denied. Allow mic access and try again.");
      } else if (name === "NotFoundError" || name === "DevicesNotFoundError") {
        setStatus("No microphone was found on this device.");
      } else {
        setStatus(error instanceof Error ? error.message : "Microphone access is unavailable.");
      }
    }
  }

  function stopListenMode() {
    listeningRef.current = false; setIsListening(false); changeRecognitionPhase("idle");
    if (monitorIntervalRef.current) window.clearInterval(monitorIntervalRef.current);
    monitorIntervalRef.current = null;
    releaseWakeLock();
    streamRef.current?.getTracks().forEach((mediaTrack) => mediaTrack.stop());
    workletRef.current?.disconnect(); silentGainRef.current?.disconnect();
    for (const pending of snapshotRequestsRef.current.values()) { window.clearTimeout(pending.timeout); pending.reject(new Error("Listening stopped.")); }
    snapshotRequestsRef.current.clear(); recognitionGateRef.current.cancel();
    streamRef.current = null; analyserRef.current = null; workletRef.current = null; silentGainRef.current = null;
    frequencyDataRef.current = null; waveformDataRef.current = null; void audioContextRef.current?.close(); audioContextRef.current = null;
    if (listeningModeRef.current === "vinyl") { resetVinylPrediction(); lastTrackKeyRef.current = ""; }
    setStatus("Listen mode paused.");
  }

  function chooseListeningMode(mode: ListeningMode) {
    if (listeningRef.current) return;
    listeningModeRef.current = mode;
    setListeningMode(mode);
    if (mode === "live") resetVinylPrediction();
    setStatus(mode === "vinyl"
      ? "Vinyl mode will identify once — hold the phone near the speakers for the first lock, then the album can unfold."
      : "Live mode reacts to whatever you play.");
  }

  function chooseArtCuration(enabled: boolean) {
    if (listeningRef.current) return;
    artCurationEnabledRef.current = enabled;
    setArtCurationEnabled(enabled);
    setStatus(enabled
      ? "Artwork curation is on — each recognized track will receive a visual pairing."
      : "Artwork curation is off — Vinyl Mode will show track and album information only.");
  }

  async function ensureDisplaySession(preferredCode?: string) {
    if (!preferredCode || !isDisplayCode(preferredCode)) {
      setDisplayPairStatus("Scan the QR on the TV, or type the six-character code shown there.");
      return;
    }
    const code = normalizeDisplayCode(preferredCode);
    setDisplayPairStatus("Linking to your TV…");
    try {
      const response = await fetch("/api/display/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        setDisplayPairStatus(typeof payload.error === "string" ? payload.error : "Could not link to the TV.");
        return;
      }
      if (typeof payload.code !== "string" || !isDisplayCode(payload.code)) {
        setDisplayPairStatus("Pairing response was incomplete.");
        return;
      }
      setDisplayCode(normalizeDisplayCode(payload.code));
      setDisplayCodeDraft("");
      setDisplayPairStatus("Linked — this phone stays paired until you forget.");
    } catch (error) {
      setDisplayPairStatus(error instanceof Error ? error.message : "Could not link to the TV.");
    }
  }

  function submitDisplayCode(event: React.FormEvent) {
    event.preventDefault();
    void ensureDisplaySession(displayCodeDraft);
  }

  function forgetDisplaySession() {
    try { window.localStorage.removeItem(CONTROLLER_CODE_STORAGE_KEY); } catch { /* optional */ }
    setDisplayCode("");
    setDisplayCodeDraft("");
    setDisplayPairStatus("TV unlinked. Scan the QR on the TV to pair again.");
  }

  function buildDisplaySnapshot(): DisplaySnapshot {
    const live = hasLiveTrack || isPresentationAct(act);
    return {
      act,
      listeningMode,
      isListening,
      status: sanitizeDisplayStatus(status, isListening),
      currentTrack: live ? {
        artist: currentTrack.artist,
        title: currentTrack.title,
        album: currentTrack.album,
        year: currentTrack.year,
        ...(currentTrack.albumCover ? { albumCover: currentTrack.albumCover } : {}),
        ...(currentTrack.genre ? { genre: currentTrack.genre } : {}),
      } : null,
      artwork: {
        ...(art.id ? { id: art.id } : {}),
        title: art.title,
        artist: art.artist,
        date: art.date,
        museum: art.museum,
        image: art.image,
        rationale: art.rationale,
      },
      vinylProgress,
      ...(vinylBoundaryAtRef.current ? { vinylBoundaryAt: vinylBoundaryAtRef.current } : {}),
      updatedAt: Date.now(),
    };
  }

  useEffect(() => {
    if (!displayCode) return;
    const snapshot = buildDisplaySnapshot();
    const timer = window.setTimeout(() => {
      void fetch("/api/display/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: displayCode, snapshot }),
      }).then(async (response) => {
        if (response.ok) return;
        const payload = await response.json().catch(() => ({}));
        if (typeof payload.error === "string") setDisplayPairStatus(payload.error);
      }).catch(() => setDisplayPairStatus("Could not publish to the TV session."));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [displayCode, act, listeningMode, isListening, status, currentTrack, art, vinylProgress]);

  const listenControl = <button className="listen-control" onClick={isListening ? stopListenMode : startListenMode}>{isListening ? "Pause listening" : listeningMode === "vinyl" ? "Start vinyl mode" : "Start live mode"}</button>;
  const microphonePicker = <label className="microphone-picker"><span>Microphone</span><select value={selectedDeviceId} onChange={(event) => setSelectedDeviceId(event.target.value)} disabled={isListening}><option value="">System default</option>{audioInputs.map((input) => <option key={input.deviceId} value={input.deviceId}>{input.label}</option>)}</select></label>;
  const modePicker = <div className="mode-picker" role="group" aria-label="Listening mode"><button type="button" className={listeningMode === "live" ? "is-active" : ""} onClick={() => chooseListeningMode("live")} disabled={isListening}><strong>Live</strong><span>Follow anything you play</span></button><button type="button" className={listeningMode === "vinyl" ? "is-active" : ""} onClick={() => chooseListeningMode("vinyl")} disabled={isListening}><strong>Vinyl</strong><span>Predict the album sequence</span></button></div>;
  const curationPicker = <div className="curation-picker" role="group" aria-label="Artwork curation"><button type="button" className={artCurationEnabled ? "is-active" : ""} onClick={() => chooseArtCuration(true)} disabled={isListening}>Art curation on</button><button type="button" className={!artCurationEnabled ? "is-active" : ""} onClick={() => chooseArtCuration(false)} disabled={isListening}>Music info only</button></div>;
  const tvPairPanel = (
    <aside className="tv-pair" aria-label="Television pairing">
      <div className="tv-pair__copy">
        <strong>{displayCode ? "Linked to TV" : "Show on TV"}</strong>
        <span>{displayPairStatus || (displayCode ? "This phone stays paired until you forget." : "Open /display on the TV, then scan its QR with this phone.")}</span>
      </div>
      {displayCode ? (
        <p className="tv-pair__code" aria-live="polite">{displayCode}</p>
      ) : (
        <form className="tv-pair__form" onSubmit={submitDisplayCode}>
          <input
            value={displayCodeDraft}
            onChange={(event) => setDisplayCodeDraft(normalizeDisplayCode(event.target.value))}
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            maxLength={6}
            placeholder="TV code"
            inputMode="text"
            aria-label="TV pairing code"
          />
          <button type="submit" disabled={displayCodeDraft.length < 6}>Link</button>
        </form>
      )}
      {displayCode ? (
        <div className="tv-pair__actions">
          <button type="button" className="tv-pair__ghost" onClick={forgetDisplaySession}>
            Forget TV
          </button>
        </div>
      ) : null}
    </aside>
  );
  const vinylSeconds = vinylBoundaryAtRef.current ? Math.round((vinylBoundaryAtRef.current - Date.now()) / 1000) : undefined;
  const nextVinylHeartbeatAt = [vinylMidpointHeartbeatAtRef.current, vinylPreTransitionHeartbeatAtRef.current].filter((at) => at > 0).sort((left, right) => left - right)[0];
  const vinylHeartbeatSeconds = nextVinylHeartbeatAt ? Math.max(0, Math.round((nextVinylHeartbeatAt - Date.now()) / 1000)) : undefined;
  const vinylCalibrationMs = vinylTimingCalibrationRef.current.offsetMs;
  const vinylDebugFlags = listeningMode === "vinyl" ? [
    vinylParkedRef.current ? "parked" : null,
    vinylGapPendingRef.current ? "gap" : null,
    vinylAdvancePendingVerifyRef.current ? "verify" : null,
    vinylEndConfirmPendingRef.current
      ? (vinylEndConfirmArmedAtRef.current ? "end-capturing" : "end-waiting")
      : null,
    vinylLastAdvanceReasonRef.current !== "none" ? `adv:${vinylLastAdvanceReasonRef.current}` : null,
    vinylCalibrationMs !== 0 ? `cal:${vinylCalibrationMs}ms` : null,
  ].filter(Boolean).join(" ") : "";
  const debugPanel = showAudioDebug ? <aside className="audio-debug" aria-label="Audio detector diagnostics"><strong>{audioDebug.state}</strong><span>{listeningMode}</span>{activeMicrophone && <span>{activeMicrophone}</span>}<span>change {audioDebug.score.toFixed(3)}</span><span>rms {audioDebug.rms.toFixed(3)}</span><span>AudD calls {auddCalls}</span><span>wake {wakeLockState}</span>{vinylSeconds !== undefined && <span>next {vinylSeconds}s</span>}{vinylHeartbeatSeconds !== undefined && <span>heartbeat {vinylHeartbeatSeconds}s</span>}{vinylDebugFlags && <span>{vinylDebugFlags}</span>}<span>{audioDebug.reason}</span>{captureDebug && <span>{captureDebug}</span>}{lastSampleUrl && <a href={lastSampleUrl} download="music-art-last-sample.wav" onClick={(event) => event.stopPropagation()}>download sample</a>}</aside> : null;
  const transitionLabel = recognitionPhase === "suspected" ? "Possible new song" : recognitionPhase === "checking" ? "Identifying new song" : "New selection found";
  const vinylSequenceIsActive = listeningMode === "vinyl" && Boolean(vinylAlbumRef.current);
  const transitionIndicator = !vinylSequenceIsActive && (recognitionPhase === "suspected" || recognitionPhase === "checking" || recognitionPhase === "matched") ? <aside className="transition-indicator" data-phase={recognitionPhase} aria-live="polite"><span className="signal-bars" aria-hidden="true"><i /><i /><i /><i /></span><span><small>{recognitionPhase === "suspected" ? "Listening closely" : recognitionPhase === "checking" ? "Checking the sound" : "Now playing"}</small><strong>{transitionLabel}</strong></span></aside> : null;

  if (act === "ready") return <main className="ready"><p className="eyebrow">Needle & Frame</p><h1>{hasLiveTrack ? "Listen again" : "Listen and identify"}</h1><p>{hasLiveTrack ? `Last identified: ${currentTrack.title} — ${currentTrack.artist}` : listeningMode === "vinyl" ? "Identify the record once, then let the album unfold." : "Identify a song, then discover a matching artwork."}</p>{modePicker}{curationPicker}{microphonePicker}{listenControl}{tvPairPanel}<small>{status}</small>{transitionIndicator}{debugPanel}</main>;
  if (isPresentationAct(act)) {
    return (
      <PresentationStage
        snapshot={{
          act,
          listeningMode,
          isListening,
          status,
          currentTrack: hasLiveTrack ? {
            artist: currentTrack.artist,
            title: currentTrack.title,
            album: currentTrack.album,
            year: currentTrack.year,
            ...(currentTrack.albumCover ? { albumCover: currentTrack.albumCover } : {}),
            ...(currentTrack.genre ? { genre: currentTrack.genre } : {}),
          } : null,
          artwork: {
            ...(art.id ? { id: art.id } : {}),
            title: art.title,
            artist: art.artist,
            date: art.date,
            museum: art.museum,
            image: art.image,
            rationale: art.rationale,
          },
          vinylProgress,
          ...(vinylBoundaryAtRef.current ? { vinylBoundaryAt: vinylBoundaryAtRef.current } : {}),
          updatedAt: Date.now(),
        }}
        chrome={<>{transitionIndicator}{debugPanel}</>}
        onGalleryClick={() => setAct("ready")}
        showCurationStatus={artCurationEnabled}
      />
    );
  }
  return null;
}
