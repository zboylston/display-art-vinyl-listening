export type TrackIdentity = { isrc?: string; artist: string; title: string };
export const INITIAL_DISCOVERY_CAPTURE_MS = 15_000;
export const INITIAL_DISCOVERY_RETRY_MS = 10_000;

function canonical(value: string) {
  return value.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Stable artist|title key — ignores ISRC so vinyl album tracks match AudD results. */
export function textTrackKey(track: TrackIdentity): string {
  return `text:${canonical(track.artist)}|${canonical(track.title)}`;
}

export function canonicalTrackKey(track: TrackIdentity): string {
  const isrc = track.isrc?.trim().toUpperCase();
  return isrc ? `isrc:${isrc}` : textTrackKey(track);
}

export function noMatchRetryDelay(
  hasConfirmedTrack: boolean,
  consecutiveMisses: number,
  safetyCheckMs = 120_000,
) {
  if (!hasConfirmedTrack) return INITIAL_DISCOVERY_RETRY_MS;
  if (consecutiveMisses === 1) return 12_000;
  if (consecutiveMisses === 2) return 30_000;
  return safetyCheckMs;
}

export class RecognitionGate {
  private inFlight = false;
  private cooldownUntil = 0;

  tryStart(at: number): boolean {
    if (this.inFlight || at < this.cooldownUntil) return false;
    this.inFlight = true;
    return true;
  }

  finish(at: number, cooldownMs: number) {
    this.inFlight = false;
    this.cooldownUntil = at + cooldownMs;
  }

  cancel() { this.inFlight = false; }
  get nextAllowedAt() { return this.cooldownUntil; }
}
