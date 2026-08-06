export type DetectorState = "warming" | "stable" | "suspected" | "resuming" | "cooldown" | "silence";
export type DetectorEvent = "music-started" | "music-resumed" | "change-suspected" | "silence" | null;

export type FeatureFrame = {
  at: number;
  spectrum: number[];
  rms: number;
};

export type DetectorUpdate = {
  event: DetectorEvent;
  state: DetectorState;
  score: number;
  rms: number;
};

export type DetectorConfig = {
  changeThreshold: number;
  sustainedMs: number;
  silenceMs: number;
  resumeMs: number;
  initialMusicMs: number;
  rmsThreshold: number;
  baselineStartMs: number;
  baselineEndMs: number;
  recentMs: number;
  historyMs: number;
  audibleDropoutMs: number;
  minimumAudibleRatio: number;
};

export const DEFAULT_DETECTOR_CONFIG: DetectorConfig = {
  // Cosine distance over normalized spectral shape. Volume alone has little effect.
  changeThreshold: 0.12,
  sustainedMs: 2_750,
  // Digital and vinyl track gaps are often well under two seconds. A short
  // gap arms recognition; the five-second resume requirement filters clicks.
  silenceMs: 650,
  resumeMs: 5_000,
  // Initial discovery uses a full 15-second window. In our room tests AudD
  // fingerprinted the 15-second recording but rejected shorter excerpts.
  initialMusicMs: 15_000,
  rmsThreshold: 0.012,
  baselineStartMs: 18_000,
  baselineEndMs: 5_000,
  recentMs: 4_000,
  historyMs: 24_000,
  audibleDropoutMs: 1_250,
  minimumAudibleRatio: 0.55,
};

export function normalizeVector(values: readonly number[]): number[] {
  const magnitude = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  if (!Number.isFinite(magnitude) || magnitude === 0) return values.map(() => 0);
  return values.map((value) => value / magnitude);
}

export function cosineDistance(left: readonly number[], right: readonly number[]): number {
  if (left.length !== right.length || left.length === 0) return 1;
  const a = normalizeVector(left);
  const b = normalizeVector(right);
  let similarity = 0;
  for (let index = 0; index < a.length; index += 1) similarity += a[index] * b[index];
  return Math.max(0, Math.min(1, 1 - similarity));
}

export function averageSpectrum(frames: readonly FeatureFrame[]): number[] | null {
  if (!frames.length) return null;
  const average = new Array(frames[0].spectrum.length).fill(0) as number[];
  for (const frame of frames) {
    if (frame.spectrum.length !== average.length) return null;
    for (let index = 0; index < average.length; index += 1) average[index] += frame.spectrum[index];
  }
  return normalizeVector(average.map((value) => value / frames.length));
}

/** Convert FFT decibels into 16 normalized, logarithmically spaced frequency bands. */
export function spectrumBandsFromDb(
  decibels: Float32Array,
  sampleRate: number,
  fftSize: number,
  bandCount = 16,
): number[] {
  const nyquist = sampleRate / 2;
  const lowHz = 70;
  const highHz = Math.min(14_000, nyquist);
  const hzPerBin = sampleRate / fftSize;
  const bands: number[] = [];

  for (let band = 0; band < bandCount; band += 1) {
    const startHz = lowHz * Math.pow(highHz / lowHz, band / bandCount);
    const endHz = lowHz * Math.pow(highHz / lowHz, (band + 1) / bandCount);
    const start = Math.max(0, Math.floor(startHz / hzPerBin));
    const end = Math.min(decibels.length, Math.max(start + 1, Math.ceil(endHz / hzPerBin)));
    let power = 0;
    for (let bin = start; bin < end; bin += 1) {
      const db = Number.isFinite(decibels[bin]) ? decibels[bin] : -120;
      power += Math.pow(10, db / 10);
    }
    bands.push(Math.log1p((power / Math.max(1, end - start)) * 1_000_000));
  }

  return normalizeVector(bands);
}

export function rmsFromSamples(samples: Float32Array): number {
  if (!samples.length) return 0;
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return Math.sqrt(sum / samples.length);
}

export class AudioChangeDetector {
  private readonly config: DetectorConfig;
  private frames: FeatureFrame[] = [];
  private currentState: DetectorState = "warming";
  private audibleSince: number | null = null;
  private silentSince: number | null = null;
  private suspectSince: number | null = null;
  private cooldownUntil = 0;
  private hasStarted = false;
  private lastAudibleAt: number | null = null;

  constructor(config: Partial<DetectorConfig> = {}) {
    this.config = { ...DEFAULT_DETECTOR_CONFIG, ...config };
  }

  get state(): DetectorState { return this.currentState; }

  markRecognition(at: number, cooldownMs: number) {
    this.cooldownUntil = at + cooldownMs;
    this.currentState = "cooldown";
    this.suspectSince = null;
  }

  resetHistory(at: number) {
    this.frames = this.frames.filter((frame) => frame.at >= at - this.config.recentMs);
    this.suspectSince = null;
    this.currentState = at < this.cooldownUntil ? "cooldown" : "warming";
  }

  push(frame: FeatureFrame): DetectorUpdate {
    this.frames.push({ ...frame, spectrum: normalizeVector(frame.spectrum) });
    this.frames = this.frames.filter((item) => item.at >= frame.at - this.config.historyMs);

    if (frame.rms < this.config.rmsThreshold) return this.handleQuiet(frame);
    return this.handleAudible(frame);
  }

  private handleQuiet(frame: FeatureFrame): DetectorUpdate {
    // Real music regularly dips below the RMS threshold. Preserve an in-progress
    // resume across short dropouts so one quiet beat cannot strand us in silence.
    this.silentSince ??= frame.at;
    if (this.audibleSince !== null && this.lastAudibleAt !== null
      && frame.at - this.lastAudibleAt < this.config.audibleDropoutMs
      && frame.at - this.silentSince < this.config.silenceMs) {
      return { event: null, state: this.currentState, score: 0, rms: frame.rms };
    }
    this.audibleSince = null;
    this.suspectSince = null;
    let event: DetectorEvent = null;
    if (frame.at - this.silentSince >= this.config.silenceMs && this.currentState !== "silence") {
      this.currentState = "silence";
      event = "silence";
    }
    return { event, state: this.currentState, score: 0, rms: frame.rms };
  }

  private handleAudible(frame: FeatureFrame): DetectorUpdate {
    const resumedAfterSilence = this.silentSince !== null && frame.at - this.silentSince >= this.config.silenceMs;
    this.audibleSince ??= frame.at;
    this.silentSince = null;
    this.lastAudibleAt = frame.at;

    if (!this.hasStarted || resumedAfterSilence || this.currentState === "silence" || this.currentState === "resuming") {
      const isResume = this.hasStarted;
      const required = this.hasStarted ? this.config.resumeMs : this.config.initialMusicMs;
      if (this.hasStarted) this.currentState = "resuming";
      const evidence = this.frames.filter((item) => item.at >= frame.at - required);
      const audibleRatio = evidence.filter((item) => item.rms >= this.config.rmsThreshold).length / Math.max(1, evidence.length);
      if (frame.at - this.audibleSince >= required && audibleRatio >= this.config.minimumAudibleRatio && frame.at >= this.cooldownUntil) {
        this.hasStarted = true;
        this.currentState = "warming";
        this.audibleSince = null;
        return { event: isResume ? "music-resumed" : "music-started", state: this.currentState, score: 0, rms: frame.rms };
      }
      return { event: null, state: this.currentState, score: 0, rms: frame.rms };
    }

    if (frame.at < this.cooldownUntil) {
      this.currentState = "cooldown";
      return { event: null, state: this.currentState, score: 0, rms: frame.rms };
    }

    const baseline = averageSpectrum(this.frames.filter((item) => (
      item.rms >= this.config.rmsThreshold
      && item.at >= frame.at - this.config.baselineStartMs
      && item.at <= frame.at - this.config.baselineEndMs
    )));
    const recent = averageSpectrum(this.frames.filter((item) => (
      item.rms >= this.config.rmsThreshold && item.at >= frame.at - this.config.recentMs
    )));
    const hasEnoughHistory = this.frames[0] && frame.at - this.frames[0].at >= this.config.baselineStartMs;
    if (!baseline || !recent || !hasEnoughHistory) {
      this.currentState = "warming";
      return { event: null, state: this.currentState, score: 0, rms: frame.rms };
    }

    const score = cosineDistance(baseline, recent);
    // The rolling score rejects momentary noise; the current-frame score lets a
    // recovered song disarm immediately instead of waiting for that noise to age out.
    const currentScore = cosineDistance(baseline, frame.spectrum);
    if (score >= this.config.changeThreshold && currentScore >= this.config.changeThreshold) {
      this.suspectSince ??= frame.at;
      this.currentState = "suspected";
      if (frame.at - this.suspectSince >= this.config.sustainedMs) {
        this.suspectSince = null;
        return { event: "change-suspected", state: this.currentState, score, rms: frame.rms };
      }
    } else {
      this.suspectSince = null;
      this.currentState = "stable";
    }
    return { event: null, state: this.currentState, score, rms: frame.rms };
  }
}
