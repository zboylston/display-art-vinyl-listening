export type VinylProgress = {
  discNumber?: number;
  trackIndex: number;
  totalTracks: number;
};

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
