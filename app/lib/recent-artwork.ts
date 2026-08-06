export const RECENT_ARTWORK_LIMIT = 32;
export const MIN_CANDIDATES_AFTER_EXCLUDE = 8;

/** Most-recent-first rolling history of museum artwork ids (e.g. met:123). */
export function pushRecentArtworkId(ids: string[], id: string, limit = RECENT_ARTWORK_LIMIT) {
  const cleaned = id.trim();
  if (!cleaned) return ids;
  return [cleaned, ...ids.filter((item) => item !== cleaned)].slice(0, limit);
}

export function parseRecentArtworkIds(value: unknown, limit = RECENT_ARTWORK_LIMIT): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const id = item.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length === limit) break;
  }
  return ids;
}

/** Drop recently shown works when a usable judging pool remains. */
export function excludeRecentCandidates<T extends { id: string }>(
  candidates: T[],
  excludeIds: string[],
  minKeep = MIN_CANDIDATES_AFTER_EXCLUDE,
) {
  if (!excludeIds.length) return candidates;
  const excluded = new Set(excludeIds);
  const filtered = candidates.filter((candidate) => !excluded.has(candidate.id));
  return filtered.length >= minKeep ? filtered : candidates;
}

/** Skip a per-track cache hit when that piece was already shown recently. */
export function shouldRefreshCachedArtwork(cachedId: string | undefined, recentIds: string[]) {
  if (!cachedId) return false;
  return recentIds.includes(cachedId);
}
