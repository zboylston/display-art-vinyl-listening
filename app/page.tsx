"use client";

import { useEffect, useRef, useState } from "react";
import { AudioChangeDetector, rmsFromSamples, spectrumBandsFromDb, type DetectorState } from "./lib/audio-change-detector";
import { canonicalTrackKey, INITIAL_DISCOVERY_CAPTURE_MS, noMatchRetryDelay, RecognitionGate, textTrackKey } from "./lib/recognition";
import { parseRecentArtworkIds, pushRecentArtworkId, shouldRefreshCachedArtwork } from "./lib/recent-artwork";
import { planVinylHeartbeats } from "./lib/vinyl-heartbeats";
import { isNearVinylBoundary, findVinylAlbumIndex, refinedVinylBoundaryAt, remainingTrackMs, shiftedBoundaryAfterPause, timecodeAtCaptureMs } from "./lib/vinyl-mode";
import { vinylFolioCopy, type VinylProgress } from "./lib/vinyl-folio";
import { encodeMonoWav, prepareRecognitionAudio } from "./lib/wav";

type Act = "ready" | "track" | "handoff" | "art" | "art-fade" | "gallery" | "return";
type ListeningMode = "live" | "vinyl";
type AudioInput = { deviceId: string; label: string };
type Artwork = { id?: string; title: string; artist: string; date: string; museum: string; image: string; rationale: string; brief?: unknown };
type Track = { artist: string; title: string; album: string; year: string; albumCover?: string; isrc?: string; durationMs?: number; timecodeMs?: number; collectionId?: number; trackNumber?: number; discNumber?: number; side?: string; genre?: string };
type RecognitionReason = "music-started" | "music-resumed" | "spectral-change" | "expected-ending" | "safety-check" | "heartbeat" | "pre-transition" | "transition-confirmation" | "legacy-fallback";
type RingSnapshot = { samples: Float32Array; sampleRate: number };
type SnapshotRequest = { resolve: (snapshot: RingSnapshot) => void; reject: (error: Error) => void; timeout: number };
type AudioDebug = { state: DetectorState; score: number; rms: number; reason: string };
type RecognitionPhase = "idle" | "listening" | "suspected" | "checking" | "matched";
type RecognitionOutcome = "match" | "same" | "none" | "error";

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
const CURATION_CACHE_VERSION = "v8-grounding-first";
const RECENT_ARTWORK_STORAGE_KEY = `music-art:recent-artwork:${CURATION_CACHE_VERSION}`;
const VINYL_TIMER_VERIFY_MS = 12_000;
/** Gap/spectral advances already hear the next song — verify sooner. */
const VINYL_GAP_VERIFY_MS = 6_000;
const EARLY_TRANSITION_CONFIRM_DELAY_MS = 5_000;
/** Brief dropouts should only shift the boundary; longer pauses may mean a skip. */
const MIN_PAUSE_FOR_EARLY_CONFIRM_MS = 3_000;
const MIN_PAUSE_DURING_PRESENTATION_MS = 6_000;

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
  return reason === "heartbeat" || reason === "pre-transition" || reason === "expected-ending";
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
  /** Side letter the record is flipping away from; non-null shows the flip interstitial. */
  const [flipFromSide, setFlipFromSide] = useState<string | null>(null);
  const [audioInputs, setAudioInputs] = useState<AudioInput[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState("");
  const [activeMicrophone, setActiveMicrophone] = useState("");
  const [art, setArt] = useState<Artwork>(initialArt);
  const [status, setStatus] = useState("Ready to listen.");
  const [isListening, setIsListening] = useState(false);
  const [showAudioDebug, setShowAudioDebug] = useState(false);
  const [auddCalls, setAuddCalls] = useState(0);
  const [audioDebug, setAudioDebug] = useState<AudioDebug>({ state: "warming", score: 0, rms: 0, reason: "idle" });
  const [captureDebug, setCaptureDebug] = useState("");
  const [lastSampleUrl, setLastSampleUrl] = useState<string | null>(null);
  const [recognitionPhase, setRecognitionPhase] = useState<RecognitionPhase>("idle");
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
  const animationFrameRef = useRef<number | null>(null);
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
  const vinylAdvanceInFlightRef = useRef(false);
  const vinylPreloadRef = useRef<{ key: string; promise: Promise<Artwork> } | null>(null);
  const vinylMidpointHeartbeatAtRef = useRef(0);
  const vinylPreTransitionHeartbeatAtRef = useRef(0);
  const vinylEarlyConfirmationTimerRef = useRef<number | null>(null);
  /** Index of the side-B opener waiting on the physical flip; null when no flip is pending. */
  const vinylFlipPendingRef = useRef<number | null>(null);
  const previousDetectorStateRef = useRef<DetectorState>("warming");
  const hasLiveTrack = currentTrack !== fixtureTrack;

  useEffect(() => { currentTrackRef.current = currentTrack; }, [currentTrack]);
  useEffect(() => { actRef.current = act; }, [act]);
  useEffect(() => { setShowAudioDebug(new URLSearchParams(window.location.search).get("debugAudio") === "1"); }, []);
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
    if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
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
    const cached = resolveArtworkCache(key);
    const prepared = preparedArtwork && !shouldRefreshCachedArtwork(preparedArtwork.id, readRecentArtworkIds())
      ? preparedArtwork
      : undefined;
    const artwork = prepared ?? cached ?? await fetchArtwork(track);
    if (presentationId !== presentationIdRef.current) return;
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

  function resetVinylPrediction() {
    vinylAlbumRef.current = null;
    vinylBoundaryAtRef.current = 0;
    vinylPauseAtRef.current = 0;
    vinylGapPendingRef.current = false;
    vinylAdvanceInFlightRef.current = false;
    vinylPreloadRef.current = null;
    vinylMidpointHeartbeatAtRef.current = 0;
    vinylPreTransitionHeartbeatAtRef.current = 0;
    vinylFlipPendingRef.current = null;
    setFlipFromSide(null);
    if (vinylEarlyConfirmationTimerRef.current) window.clearTimeout(vinylEarlyConfirmationTimerRef.current);
    vinylEarlyConfirmationTimerRef.current = null;
    setVinylProgress(null);
  }

  function updateVinylProgress() {
    const album = vinylAlbumRef.current;
    if (!album) { setVinylProgress(null); return; }
    const current = album.tracks[album.index];
    const side = current?.side;
    let sideTrackIndex: number | undefined;
    let sideTrackTotal: number | undefined;
    if (side) {
      sideTrackIndex = album.tracks.slice(0, album.index + 1).filter((track) => track.side === side).length - 1;
      sideTrackTotal = album.tracks.filter((track) => track.side === side).length;
    }
    setVinylProgress({ discNumber: current?.discNumber, side, sideTrackIndex, sideTrackTotal, trackIndex: album.index, totalTracks: album.tracks.length });
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
    // AudD reports a position in the captured fragment. Advance from that
    // rolling window to the moment the snapshot ended, then account for the
    // request in flight; otherwise every predicted handoff is a clip late.
    const elapsedSinceCapture = Math.min(25_000, Math.max(0, Date.now() - capturedAt));
    const anchoredTimecode = timecodeAtCaptureMs(recognizedTrack.timecodeMs, sampleDurationMs, elapsedSinceCapture);
    tracks[matchedIndex].timecodeMs = anchoredTimecode;
    const remaining = remainingTrackMs(recognizedTrack.durationMs ?? tracks[matchedIndex].durationMs, anchoredTimecode);
    vinylBoundaryAtRef.current = remaining ? Date.now() + remaining : 0;
    vinylPauseAtRef.current = 0;
    vinylGapPendingRef.current = false;
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

  /** Snap the locked sequence to a heard album track (confirm, skip, or rollback). */
  function syncVinylIndexToHeardTrack(recognizedTrack: Track, index: number, capturedAt: number, sampleDurationMs = 0) {
    const album = vinylAlbumRef.current;
    if (!album || index < 0 || index >= album.tracks.length) return null;
    const current = album.tracks[index];
    album.index = index;
    const elapsedSinceCapture = Math.min(25_000, Math.max(0, Date.now() - capturedAt));
    const anchoredTimecode = timecodeAtCaptureMs(recognizedTrack.timecodeMs, sampleDurationMs, elapsedSinceCapture) ?? 0;
    album.tracks[index] = {
      ...current,
      isrc: recognizedTrack.isrc ?? current.isrc,
      durationMs: recognizedTrack.durationMs ?? current.durationMs,
      albumCover: recognizedTrack.albumCover ?? current.albumCover,
      genre: recognizedTrack.genre ?? current.genre,
      timecodeMs: anchoredTimecode,
    };
    const remaining = remainingTrackMs(album.tracks[index].durationMs, anchoredTimecode);
    vinylBoundaryAtRef.current = remaining
      ? Date.now() + remaining
      : album.tracks[index].durationMs
        ? Date.now() + album.tracks[index].durationMs
        : 0;
    vinylPauseAtRef.current = 0;
    vinylGapPendingRef.current = false;
    nextFallbackAtRef.current = 0;
    scheduleVinylHeartbeats();
    updateVinylProgress();
    return album.tracks[index];
  }

  function scheduleVinylAdvanceVerify(reason: "gap" | "timer" | "spectral") {
    const delay = reason === "timer" ? VINYL_TIMER_VERIFY_MS : VINYL_GAP_VERIFY_MS;
    nextFallbackAtRef.current = Date.now() + delay;
    nextFallbackReasonRef.current = "expected-ending";
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

  async function advanceVinyl(reason: "gap" | "timer" | "spectral") {
    const album = vinylAlbumRef.current;
    if (!album || vinylAdvanceInFlightRef.current) return false;
    const nextIndex = album.index + 1;
    const next = album.tracks[nextIndex];
    if (!next) {
      vinylBoundaryAtRef.current = 0;
      vinylMidpointHeartbeatAtRef.current = 0;
      vinylPreTransitionHeartbeatAtRef.current = 0;
      setVinylProgress(null);
      setStatus("The album sequence is complete — listening for the next record.");
      return false;
    }
    const currentSide = album.tracks[album.index]?.side;
    // Confirmed side change: hold the advance behind the physical record flip.
    if (next.side && currentSide && next.side !== currentSide) {
      enterVinylFlip(nextIndex, currentSide);
      return true;
    }
    return commitVinylAdvance(nextIndex, reason);
  }

  function enterVinylFlip(nextIndex: number, fromSide: string) {
    vinylFlipPendingRef.current = nextIndex;
    vinylBoundaryAtRef.current = 0;
    vinylMidpointHeartbeatAtRef.current = 0;
    vinylPreTransitionHeartbeatAtRef.current = 0;
    vinylPauseAtRef.current = 0;
    vinylGapPendingRef.current = false;
    if (vinylEarlyConfirmationTimerRef.current) window.clearTimeout(vinylEarlyConfirmationTimerRef.current);
    vinylEarlyConfirmationTimerRef.current = null;
    changeRecognitionPhase("idle");
    setFlipFromSide(fromSide);
  }

  /** Manual continue from the flip screen — trust the sequence, verify after. */
  function completeVinylFlip() {
    const pending = vinylFlipPendingRef.current;
    if (pending === null) return;
    vinylFlipPendingRef.current = null;
    setFlipFromSide(null);
    void commitVinylAdvance(pending, "gap");
  }

  async function commitVinylAdvance(nextIndex: number, reason: "gap" | "timer" | "spectral") {
    const album = vinylAlbumRef.current;
    const next = album?.tracks[nextIndex];
    if (!album || !next || vinylAdvanceInFlightRef.current) return false;
    vinylAdvanceInFlightRef.current = true;
    album.index = nextIndex;
    next.timecodeMs = 0;
    vinylBoundaryAtRef.current = next.durationMs ? Date.now() + next.durationMs : 0;
    vinylPauseAtRef.current = 0;
    vinylGapPendingRef.current = false;
    if (vinylEarlyConfirmationTimerRef.current) window.clearTimeout(vinylEarlyConfirmationTimerRef.current);
    vinylEarlyConfirmationTimerRef.current = null;
    scheduleVinylHeartbeats();
    lastTrackKeyRef.current = identityKey(next);
    updateVinylProgress();
    changeRecognitionPhase("matched");
    if (phaseTimerRef.current) window.clearTimeout(phaseTimerRef.current);
    phaseTimerRef.current = window.setTimeout(() => changeRecognitionPhase("listening"), 2_800);
    // Optimistic advance, then confirm the needle landed on the planned track.
    scheduleVinylAdvanceVerify(reason);
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
      const form = new FormData();
      form.append("audio", audio, `capture.${extension}`);
      form.append("mode", listeningModeRef.current);
      // First vinyl ID only: assume the needle is at track 1 so box sets / comps lose.
      if (listeningModeRef.current === "vinyl" && !vinylAlbumRef.current) form.append("preferAlbumOpener", "1");
      const response = await fetch("/api/recognize", { method: "POST", body: form, signal: AbortSignal.timeout(40000) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (shouldAnnounceRecognitionStatus(reason)) setStatus(`Recognition error ${response.status}: ${data.error ?? "Unknown response"}`);
        return "error";
      }
      if (!data.result) {
        if (shouldAnnounceRecognitionStatus(reason)) setStatus(listeningRef.current ? "No confident match yet — still listening…" : "No match found.");
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
        timecodeMs: timecodeToMs(data.result.timecode),
        collectionId: data.result.collectionId,
        trackNumber: data.result.trackNumber,
        discNumber: data.result.discNumber,
        genre: typeof data.result.genre === "string" ? data.result.genre : undefined,
      };
      const key = identityKey(track);
      const album = vinylAlbumRef.current;
      if (album) {
        const flipPending = vinylFlipPendingRef.current;
        const heardIndex = findVinylAlbumIndex(album.tracks, track, textTrackKey, album.index);
        if (heardIndex === album.index) {
          refineVinylTiming(track, capturedAt, sampleDurationMs);
          preloadNextVinylArtwork();
          // Cancel any fallback pre-armed by monitorSound for this confirm.
          nextFallbackAtRef.current = 0;
          if (flipPending !== null) {
            // The needle landed back on the same side — leave the interstitial.
            vinylFlipPendingRef.current = null;
            setFlipFromSide(null);
          }
          return "same";
        }
        // Any other resolution exits the flip before correcting or re-anchoring.
        if (flipPending !== null) {
          vinylFlipPendingRef.current = null;
          setFlipFromSide(null);
        }
        if (heardIndex >= 0) {
          // Planned advance was wrong, or the needle skipped — snap to what AudD heard.
          const corrected = syncVinylIndexToHeardTrack(track, heardIndex, capturedAt, sampleDurationMs);
          if (corrected) {
            lastTrackKeyRef.current = identityKey(corrected);
            const presentation = presentTrack(corrected);
            void presentation.catch((error) => setStatus(error instanceof Error ? error.message : "Artwork selection is unavailable."));
            return "match";
          }
        }
        // Off-album: rebuild the sequence from the fresh recognition.
        const vinylAnchored = anchorVinylSequence(data.result as Record<string, unknown>, track, capturedAt, sampleDurationMs);
        if (!vinylAnchored) scheduleFallbackForTrack(track);
        lastTrackKeyRef.current = key;
        const presentation = presentTrack(track);
        void presentation.catch((error) => setStatus(error instanceof Error ? error.message : "Artwork selection is unavailable."));
        return "match";
      }
      if (key === lastTrackKeyRef.current) {
        if (shouldAnnounceRecognitionStatus(reason)) setStatus("Still listening…");
        return "same";
      }
      const vinylAnchored = anchorVinylSequence(data.result as Record<string, unknown>, track, capturedAt, sampleDurationMs);
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
    if (outcome === "none" || outcome === "error") {
      consecutiveNoMatchRef.current += 1;
      // Keep post-advance verifies on the fast expected-ending path for a couple
      // of misses so an optimistic advance can still be corrected quickly.
      if (reason === "expected-ending" && vinylAlbumRef.current && consecutiveNoMatchRef.current <= 2) {
        nextFallbackAtRef.current = now + VINYL_GAP_VERIFY_MS;
        nextFallbackReasonRef.current = "expected-ending";
      } else {
        const retryDelay = noMatchRetryDelay(Boolean(lastTrackKeyRef.current), consecutiveNoMatchRef.current, SAFETY_CHECK_MS);
        nextFallbackAtRef.current = now + retryDelay;
        nextFallbackReasonRef.current = "safety-check";
      }
    } else {
      consecutiveNoMatchRef.current = 0;
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
    if (!listeningRef.current) return;
    // Post-advance vinyl checks must run even if a heartbeat left a cooldown.
    const started = reason === "expected-ending"
      ? recognitionGateRef.current.tryStartForced()
      : recognitionGateRef.current.tryStart(now);
    if (!started) {
      // Keep a pending check alive instead of dropping it when the gate is busy.
      if (reason === "expected-ending") {
        nextFallbackAtRef.current = now + 2_000;
        nextFallbackReasonRef.current = "expected-ending";
      } else {
        nextFallbackAtRef.current = now + SAFETY_CHECK_MS;
        nextFallbackReasonRef.current = reason;
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
      const discoveryRetry = listeningModeRef.current === "vinyl" && !lastTrackKeyRef.current && consecutiveNoMatchRef.current > 0;
      const discoveryRetrySeconds = discoveryRetry ? 24 : SNAPSHOT_SECONDS;
      const snapshotSeconds = reason === "transition-confirmation" || reason === "expected-ending"
        ? 10
        : reason === "music-resumed" ? 5 : discoveryRetrySeconds;
      const snapshot = await takeRingSnapshot(snapshotSeconds);
      const capturedAt = Date.now();
      if (snapshot.samples.length < snapshot.sampleRate * 4) throw new Error("Waiting for a longer music sample.");
      const prepared = prepareRecognitionAudio(snapshot.samples, snapshot.sampleRate, discoveryRetry);
      const audio = encodeMonoWav(prepared.samples, snapshot.sampleRate);
      setCaptureDebug(`clip ${(prepared.samples.length / snapshot.sampleRate).toFixed(1)}s${prepared.conditioned ? " · EQ" : ""} · in ${prepared.inputRms.toFixed(3)} · gain ${prepared.gain.toFixed(1)}× · out ${prepared.outputRms.toFixed(3)}`);
      if (showAudioDebug) {
        if (lastSampleUrlRef.current) URL.revokeObjectURL(lastSampleUrlRef.current);
        const sampleUrl = URL.createObjectURL(audio);
        lastSampleUrlRef.current = sampleUrl;
        setLastSampleUrl(sampleUrl);
      }
      const outcome = await identifyRecording(audio, capturedAt, reason, (prepared.samples.length / snapshot.sampleRate) * 1000);
      finishRecognition(outcome, reason);
    } catch (error) {
      recognitionGateRef.current.finish(Date.now(), NO_MATCH_COOLDOWN_MS);
      detectorRef.current.markRecognition(Date.now(), NO_MATCH_COOLDOWN_MS);
      nextFallbackAtRef.current = Date.now() + (reason === "expected-ending" ? VINYL_GAP_VERIFY_MS : 10_000);
      if (reason === "expected-ending") nextFallbackReasonRef.current = "expected-ending";
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
          if (isNearVinylBoundary(vinylBoundaryAtRef.current, wallNow)) {
            vinylGapPendingRef.current = true;
            if (shouldAnnounceRecognitionStatus()) setStatus("Preparing next track…");
          } else {
            vinylPauseAtRef.current = wallNow;
          }
        }
        if (vinylMode && previousDetectorStateRef.current === "silence" && update.state === "resuming") {
          if (vinylFlipPendingRef.current !== null) void requestRecognition("transition-confirmation");
          else if (vinylGapPendingRef.current) void advanceVinyl("gap");
          else if (vinylPauseAtRef.current) {
            const pauseStartedAt = vinylPauseAtRef.current;
            vinylPauseAtRef.current = 0;
            const pauseMs = wallNow - pauseStartedAt;
            const minPauseMs = isPresentationAct(actRef.current)
              ? MIN_PAUSE_DURING_PRESENTATION_MS
              : MIN_PAUSE_FOR_EARLY_CONFIRM_MS;
            // Brief room-level dropouts only shift the boundary. A sustained
            // pause far from the predicted ending may mean a skip — confirm
            // with AudD after a short clean fingerprint window.
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
              scheduleVinylHeartbeats();
            }
          }
        }
        if (USE_AUDIO_CHANGE_DETECTOR && update.event === "music-started") void requestRecognition("music-started");
        if (USE_AUDIO_CHANGE_DETECTOR && update.event === "music-resumed" && (!predictiveVinyl || !vinylHasNext)) void requestRecognition("music-resumed");
        if (USE_AUDIO_CHANGE_DETECTOR && update.event === "change-suspected") {
          if (!vinylMode || !vinylAlbumRef.current) void requestRecognition("spectral-change");
          else if (vinylFlipPendingRef.current !== null) void requestRecognition("transition-confirmation");
          else if (isNearVinylBoundary(vinylBoundaryAtRef.current, wallNow)) void advanceVinyl("spectral");
        }
        if (vinylMode && vinylAlbumRef.current && vinylBoundaryAtRef.current > 0
          && wallNow >= vinylBoundaryAtRef.current && update.state !== "silence" && !vinylPauseAtRef.current) {
          void advanceVinyl("timer");
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
        const fallbackReason = nextFallbackReasonRef.current;
        // Clear before invoke — do not pre-arm SAFETY_CHECK_MS here. Successful
        // verifies must not leave a mid-track AudD call; failures reschedule in
        // finishRecognition / requestRecognition.
        nextFallbackAtRef.current = 0;
        void requestRecognition(fallbackReason);
      } else if (!USE_AUDIO_CHANGE_DETECTOR && wallNow - lastCheckAtRef.current >= LEGACY_CHECK_MS) void requestRecognition("legacy-fallback");
    }
    animationFrameRef.current = requestAnimationFrame(monitorSound);
  }

  async function startListenMode() {
    if (listeningRef.current) return;
    try {
      if (listeningModeRef.current === "vinyl") {
        resetVinylPrediction();
        lastTrackKeyRef.current = "";
      }
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
      monitorSound();
    } catch (error) { setStatus(error instanceof Error ? error.message : "Microphone access is unavailable."); }
  }

  function stopListenMode() {
    listeningRef.current = false; setIsListening(false); changeRecognitionPhase("idle");
    if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
    animationFrameRef.current = null; streamRef.current?.getTracks().forEach((mediaTrack) => mediaTrack.stop());
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
      ? "Vinyl mode will identify once, learn the album order, and prepare each transition."
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

  const listenControl = <button className="listen-control" onClick={isListening ? stopListenMode : startListenMode}>{isListening ? "Pause listening" : listeningMode === "vinyl" ? "Start vinyl mode" : "Start live mode"}</button>;
  const microphonePicker = <label className="microphone-picker"><span>Microphone</span><select value={selectedDeviceId} onChange={(event) => setSelectedDeviceId(event.target.value)} disabled={isListening}><option value="">System default</option>{audioInputs.map((input) => <option key={input.deviceId} value={input.deviceId}>{input.label}</option>)}</select></label>;
  const modePicker = <div className="mode-picker" role="group" aria-label="Listening mode"><button type="button" className={listeningMode === "live" ? "is-active" : ""} onClick={() => chooseListeningMode("live")} disabled={isListening}><strong>Live</strong><span>Follow anything you play</span></button><button type="button" className={listeningMode === "vinyl" ? "is-active" : ""} onClick={() => chooseListeningMode("vinyl")} disabled={isListening}><strong>Vinyl</strong><span>Predict the album sequence</span></button></div>;
  const curationPicker = <div className="curation-picker" role="group" aria-label="Artwork curation"><button type="button" className={artCurationEnabled ? "is-active" : ""} onClick={() => chooseArtCuration(true)} disabled={isListening}>Art curation on</button><button type="button" className={!artCurationEnabled ? "is-active" : ""} onClick={() => chooseArtCuration(false)} disabled={isListening}>Music info only</button></div>;
  const vinylFolio = listeningMode === "vinyl" && vinylProgress ? vinylFolioCopy(vinylProgress) : null;
  const renderVinylFolio = (screen: "album" | "art") => vinylFolio ? <aside className={`vinyl-folio vinyl-folio--${screen}`} aria-label={`Vinyl playback: ${vinylFolio.sequence}`}><p className="vinyl-folio__label"><span />Vinyl</p>{screen === "art" && <p className="vinyl-folio__title">{currentTrack.title}</p>}<p className="vinyl-folio__sequence">{vinylFolio.sequence}</p></aside> : null;
  const renderGalleryMusicHeader = () => renderVinylFolio("art") ?? (hasLiveTrack ? <aside className="gallery-music" aria-label="Now playing"><p className="vinyl-folio__label"><span />Now playing</p><p className="vinyl-folio__title">{currentTrack.title}</p><p className="vinyl-folio__sequence">{currentTrack.artist}</p></aside> : null);
  const vinylSeconds = vinylBoundaryAtRef.current ? Math.round((vinylBoundaryAtRef.current - Date.now()) / 1000) : undefined;
  const nextVinylHeartbeatAt = [vinylMidpointHeartbeatAtRef.current, vinylPreTransitionHeartbeatAtRef.current].filter((at) => at > 0).sort((left, right) => left - right)[0];
  const vinylHeartbeatSeconds = nextVinylHeartbeatAt ? Math.max(0, Math.round((nextVinylHeartbeatAt - Date.now()) / 1000)) : undefined;
  const debugPanel = showAudioDebug ? <aside className="audio-debug" aria-label="Audio detector diagnostics"><strong>{audioDebug.state}</strong><span>{listeningMode}</span>{activeMicrophone && <span>{activeMicrophone}</span>}<span>change {audioDebug.score.toFixed(3)}</span><span>rms {audioDebug.rms.toFixed(3)}</span><span>AudD calls {auddCalls}</span>{vinylSeconds !== undefined && <span>next {vinylSeconds}s</span>}{vinylHeartbeatSeconds !== undefined && <span>heartbeat {vinylHeartbeatSeconds}s</span>}<span>{audioDebug.reason}</span>{captureDebug && <span>{captureDebug}</span>}{lastSampleUrl && <a href={lastSampleUrl} download="music-art-last-sample.wav" onClick={(event) => event.stopPropagation()}>download sample</a>}</aside> : null;
  const transitionLabel = recognitionPhase === "suspected" ? "Possible new song" : recognitionPhase === "checking" ? "Identifying new song" : "New selection found";
  const vinylSequenceIsActive = listeningMode === "vinyl" && Boolean(vinylAlbumRef.current);
  const transitionIndicator = !vinylSequenceIsActive && (recognitionPhase === "suspected" || recognitionPhase === "checking" || recognitionPhase === "matched") ? <aside className="transition-indicator" data-phase={recognitionPhase} aria-live="polite"><span className="signal-bars" aria-hidden="true"><i /><i /><i /><i /></span><span><small>{recognitionPhase === "suspected" ? "Listening closely" : recognitionPhase === "checking" ? "Checking the sound" : "Now playing"}</small><strong>{transitionLabel}</strong></span></aside> : null;

  if (act === "ready") return <main className="ready"><p className="eyebrow">Needle & Frame</p><h1>{hasLiveTrack ? "Listen again" : "Listen and identify"}</h1><p>{hasLiveTrack ? `Last identified: ${currentTrack.title} — ${currentTrack.artist}` : listeningMode === "vinyl" ? "Identify the record once, then let the album unfold." : "Identify a song, then discover a matching artwork."}</p>{modePicker}{curationPicker}{microphonePicker}{listenControl}<small>{status}</small>{transitionIndicator}{debugPanel}</main>;
  if (flipFromSide) return <main className="flip-screen" style={{ width: "min(100vw, calc(100vh * 16 / 9))", height: "min(100vh, calc(100vw * 9 / 16))", minHeight: 0, margin: "auto", aspectRatio: "16 / 9" }} onClick={completeVinylFlip} role="button" aria-label={`End of side ${flipFromSide}. Flip the record, or press to continue.`}><img className="flip-screen__art" src={art.image} alt="" aria-hidden="true" /><div className="flip-screen__veil" aria-hidden="true" /><section><p className="eyebrow"><span />End of side {flipFromSide}</p><h1>Flip the record</h1><p className="flip-screen__hint">Drop the needle on the next side — still listening.<span className="flip-screen__skip">or press to continue</span></p></section>{debugPanel}</main>;
  if (act === "track" || act === "handoff") return <main className={`track-screen${act === "handoff" ? " is-handing-off" : ""}`}>{act === "handoff" && <div className="handoff-art" aria-hidden="true"><img className="handoff-backdrop" src={art.image} alt="" /><img className="handoff-image" src={art.image} alt="" /></div>}<div className="frame" key={identityKey(currentTrack)}><section className="album-panel"><div className="album-mat"><div className={`album-cover${currentTrack.albumCover ? "" : " is-missing"}`} style={{ backgroundImage: currentTrack.albumCover ? `url(${currentTrack.albumCover})` : undefined }} role="img" aria-label={currentTrack.albumCover ? `${currentTrack.album} album artwork` : "Album artwork unavailable"}>{!currentTrack.albumCover && <span>{currentTrack.album.slice(0, 1)}</span>}</div></div></section><section className="now-playing"><p className="eyebrow now-label"><span />Now playing</p><h1 className={`artist-name${currentTrack.artist.length > 20 ? " is-long" : ""}`}>{currentTrack.artist}</h1><h2 className={`song-title${currentTrack.title.length > 26 ? " is-long" : ""}`}>{currentTrack.title}</h2><div className="album-details"><p className="field-label">From the album</p><p className="album-name"><em>{currentTrack.album}</em><span className="release-year"> · {currentTrack.year}</span></p></div></section>{renderVinylFolio("album")}{artCurationEnabled && <p className="curation-status" role="status"><span aria-hidden="true" />{status}</p>}</div>{transitionIndicator}{debugPanel}</main>;
  if (act === "art" || act === "art-fade") return <main className={`art-intro${act === "art-fade" ? " is-info-fading" : ""}`} style={{ width: "min(100vw, calc(100vh * 16 / 9))", height: "min(100vh, calc(100vw * 9 / 16))", minHeight: 0, margin: "auto", aspectRatio: "16 / 9" }}><img className="art-image" style={{ position: "absolute", zIndex: 0, inset: "-3%", width: "106%", height: "106%", filter: "blur(26px) brightness(.38)", transform: "scale(1.06)" }} src={art.image} alt="" /><img className="art-image gallery-artwork" style={{ position: "absolute", zIndex: 1, inset: 0, objectFit: "cover" }} src={art.image} alt="" /><div className="art-overlay" style={{ zIndex: 2 }} /><section style={{ zIndex: 3 }}><p className="eyebrow">Selected artwork</p><h1 className={`art-title${art.title.length > 34 ? " is-long" : ""}`}><em>{art.title}</em></h1><h2>{art.artist}</h2><p>{art.date} · {art.museum}</p></section>{renderVinylFolio("art")}{transitionIndicator}{debugPanel}</main>;
  return <main className={`gallery${act === "return" ? " is-returning" : ""}`} style={{ width: "min(100vw, calc(100vh * 16 / 9))", height: "min(100vh, calc(100vw * 9 / 16))", minHeight: 0, margin: "auto", aspectRatio: "16 / 9" }} onClick={() => setAct("ready")} aria-label={`${art.title} by ${art.artist}`}><img className="art-image" style={{ position: "absolute", zIndex: 0, inset: "-3%", width: "106%", height: "106%", filter: "blur(26px) brightness(.38)", transform: "scale(1.06)" }} src={art.image} alt="" /><img className="art-image gallery-artwork" style={{ position: "absolute", zIndex: 1, inset: 0, objectFit: "cover" }} src={art.image} alt={`${art.title} by ${art.artist}`} /><div className="gallery-overlay" aria-hidden="true" /><header className="gallery-header">{renderGalleryMusicHeader()}<aside className="art-card" aria-label="Artwork details"><h2>{art.title}</h2><p className="art-card__artist">{art.artist}</p><p className="art-card__meta">{art.date} · {art.museum}</p></aside></header>{transitionIndicator}{debugPanel}</main>;
}
