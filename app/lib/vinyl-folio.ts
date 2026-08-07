export type VinylProgress = {
  discNumber?: number;
  /** Confirmed vinyl side from Discogs positions (A/B/C…). */
  side?: string;
  sideTrackIndex?: number;
  sideTrackTotal?: number;
  trackIndex: number;
  totalTracks: number;
};

function pad(value: number) {
  return String(Math.max(1, value)).padStart(2, "0");
}

function sideName(discNumber?: number) {
  if (!discNumber || discNumber < 1 || discNumber > 26) return "";
  return `SIDE ${String.fromCharCode(64 + discNumber)}`;
}

/** Human-readable record position. Confirmed sides count within the side; otherwise fall back to disc metadata. */
export function vinylFolioCopy(progress: VinylProgress) {
  if (progress.side && progress.sideTrackIndex !== undefined && progress.sideTrackTotal) {
    return { sequence: `SIDE ${progress.side} · TRACK ${pad(progress.sideTrackIndex + 1)} OF ${pad(progress.sideTrackTotal)}` };
  }
  const side = sideName(progress.discNumber);
  return { sequence: `${side ? `${side} · ` : ""}TRACK ${pad(progress.trackIndex + 1)} OF ${pad(progress.totalTracks)}` };
}
