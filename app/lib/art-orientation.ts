export type OrientedCandidate = { aspectRatio?: number };
export type SourcedCandidate = { source: string };

export const MIN_LANDSCAPE_RATIO = 1.12;
export const MIN_SQUAREISH_RATIO = 0.9;
const TELEVISION_RATIO = 16 / 9;
/** Below this many landscapes, keep square works in the curator pool. */
export const THIN_LANDSCAPE_POOL = 6;

function closestToTelevision<T extends OrientedCandidate>(candidates: T[]): T[] {
  return [...candidates].sort((left, right) => (
    Math.abs((left.aspectRatio ?? 0) - TELEVISION_RATIO)
    - Math.abs((right.aspectRatio ?? 0) - TELEVISION_RATIO)
  ));
}

/**
 * Landscape is a selection requirement whenever even one verified landscape
 * candidate exists. Square/unknown/portrait works are progressively weaker
 * fallbacks so a portrait can never beat an available landscape on mood alone.
 */
export function landscapeFirstPool<T extends OrientedCandidate>(candidates: T[]): T[] {
  const landscape = candidates.filter((candidate) => (candidate.aspectRatio ?? 0) >= MIN_LANDSCAPE_RATIO);
  if (landscape.length) return closestToTelevision(landscape);

  const squareish = candidates.filter((candidate) => {
    const ratio = candidate.aspectRatio ?? 0;
    return ratio >= MIN_SQUAREISH_RATIO && ratio < MIN_LANDSCAPE_RATIO;
  });
  if (squareish.length) return closestToTelevision(squareish);

  const unknown = candidates.filter((candidate) => candidate.aspectRatio === undefined);
  if (unknown.length) return unknown;

  return closestToTelevision(candidates);
}

/**
 * When few landscapes survive search, keep square/near-square works so thematic
 * hits are not discarded solely for orientation.
 */
export function orientationPoolForCurator<T extends OrientedCandidate>(candidates: T[]): T[] {
  const landscape = candidates.filter((candidate) => (candidate.aspectRatio ?? 0) >= MIN_LANDSCAPE_RATIO);
  if (landscape.length >= THIN_LANDSCAPE_POOL) return closestToTelevision(landscape);

  const squareish = candidates.filter((candidate) => {
    const ratio = candidate.aspectRatio ?? 0;
    return ratio >= MIN_SQUAREISH_RATIO && ratio < MIN_LANDSCAPE_RATIO;
  });
  const unknown = candidates.filter((candidate) => candidate.aspectRatio === undefined);
  const preferred = [...closestToTelevision(landscape), ...closestToTelevision(squareish), ...unknown];
  if (preferred.length) return preferred;
  return closestToTelevision(candidates);
}

/** Round-robin candidates so no single museum monopolizes the curator input. */
export function balanceBySource<T extends SourcedCandidate>(candidates: T[], limit: number): T[] {
  const groups = new Map<string, T[]>();
  for (const candidate of candidates) {
    const group = groups.get(candidate.source) ?? [];
    group.push(candidate);
    groups.set(candidate.source, group);
  }
  const balanced: T[] = [];
  let index = 0;
  while (balanced.length < limit) {
    let added = false;
    for (const group of groups.values()) {
      const candidate = group[index];
      if (!candidate) continue;
      balanced.push(candidate);
      added = true;
      if (balanced.length === limit) break;
    }
    if (!added) break;
    index += 1;
  }
  return balanced;
}
