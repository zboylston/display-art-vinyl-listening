/**
 * shazam-api's SignatureGenerator silently keeps only 12s of longer clips,
 * and it takes the *middle* — which breaks vinyl timing (offset no longer
 * lines up with the start of the upload). We trim to the trailing window
 * ourselves so offset = song position at the start of the most recent audio.
 */
export const SHAZAM_MAX_FINGERPRINT_MS = 12_000;

/**
 * Prefer the newest audio in the ring buffer. Returns how many milliseconds
 * of the original upload were discarded from the front (0 when already short).
 */
export function takeTrailingShazamFingerprint<T extends { readonly length: number; slice(start: number): T }>(
  samples: T,
  sampleRate: number,
  maxMs = SHAZAM_MAX_FINGERPRINT_MS,
): { samples: T; discardedMs: number; fingerprintMs: number } {
  const maxSamples = Math.max(1, Math.floor((sampleRate * maxMs) / 1000));
  if (samples.length <= maxSamples) {
    return {
      samples,
      discardedMs: 0,
      fingerprintMs: Math.round((samples.length / sampleRate) * 1000),
    };
  }
  const start = samples.length - maxSamples;
  const trailing = samples.slice(start);
  return {
    samples: trailing,
    discardedMs: Math.round((start / sampleRate) * 1000),
    fingerprintMs: Math.round((trailing.length / sampleRate) * 1000),
  };
}

/** Duration of the clip Shazam actually fingerprints for a given upload length. */
export function shazamFingerprintDurationMs(uploadDurationMs: number, maxMs = SHAZAM_MAX_FINGERPRINT_MS) {
  if (!Number.isFinite(uploadDurationMs) || uploadDurationMs <= 0) return 0;
  return Math.min(maxMs, uploadDurationMs);
}
