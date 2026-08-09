export type VinylProgress = {
  discNumber?: number;
  trackIndex: number;
  totalTracks: number;
};

/** Seconds left before the predicted end-of-song boundary (for the header countdown). */
export function vinylCountdownSeconds(boundaryAt: number | undefined, now: number, windowSeconds = 10) {
  if (!boundaryAt) return undefined;
  const remaining = boundaryAt - now;
  if (remaining <= 0 || remaining > windowSeconds * 1000) return undefined;
  return Math.max(0, Math.ceil(remaining / 1000));
}

function sideName(discNumber?: number) {
  if (!discNumber || discNumber < 1 || discNumber > 26) return "";
  return `SIDE ${String.fromCharCode(64 + discNumber)}`;
}

/** Human-readable record position. Avoid inventing a side when catalog metadata lacks one. */
export function vinylFolioCopy(progress: VinylProgress) {
  const track = String(Math.max(1, progress.trackIndex + 1)).padStart(2, "0");
  const total = String(Math.max(1, progress.totalTracks)).padStart(2, "0");
  const side = sideName(progress.discNumber);
  return { sequence: `${side ? `${side} · ` : ""}TRACK ${track} OF ${total}` };
}
