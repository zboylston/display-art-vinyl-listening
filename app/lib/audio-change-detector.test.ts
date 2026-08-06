import { describe, expect, it } from "vitest";
import { AudioChangeDetector, cosineDistance, normalizeVector } from "./audio-change-detector";

const warm = [8, 6, 3, 1, 0.5, 0.25];
const bright = [0.25, 0.5, 1, 3, 6, 8];

function feed(
  detector: AudioChangeDetector,
  from: number,
  to: number,
  spectrum: number[],
  rms = 0.1,
) {
  const updates = [];
  for (let at = from; at <= to; at += 250) updates.push(detector.push({ at, spectrum, rms }));
  return updates;
}

describe("spectral feature math", () => {
  it("ignores pure volume changes after normalization", () => {
    expect(cosineDistance(normalizeVector(warm), normalizeVector(warm.map((value) => value * 9)))).toBeLessThan(0.000001);
  });

  it("separates materially different spectral shapes", () => {
    expect(cosineDistance(warm, bright)).toBeGreaterThan(0.7);
  });
});

describe("AudioChangeDetector", () => {
  const config = {
    initialMusicMs: 1_000,
    baselineStartMs: 6_000,
    baselineEndMs: 2_000,
    recentMs: 1_500,
    sustainedMs: 1_000,
    historyMs: 8_000,
    silenceMs: 1_000,
    resumeMs: 1_000,
    changeThreshold: 0.15,
  };

  function warmedDetector() {
    const detector = new AudioChangeDetector(config);
    const opening = feed(detector, 0, 1_250, warm);
    expect(opening.some((update) => update.event === "music-started")).toBe(true);
    detector.markRecognition(1_250, 0);
    feed(detector, 1_500, 8_000, warm);
    return detector;
  }

  it("does not trigger on a stable song or volume jump", () => {
    const detector = warmedDetector();
    const stable = feed(detector, 8_250, 10_000, warm.map((value) => value * 3), 0.3);
    expect(stable.some((update) => update.event === "change-suspected")).toBe(false);
  });

  it("rejects a short spectral transient", () => {
    const detector = warmedDetector();
    const transient = feed(detector, 8_250, 8_750, bright);
    const recovered = feed(detector, 9_000, 11_000, warm);
    expect([...transient, ...recovered].some((update) => update.event === "change-suspected")).toBe(false);
  });

  it("triggers after a sustained spectral change", () => {
    const detector = warmedDetector();
    const changed = feed(detector, 8_250, 12_000, bright);
    expect(changed.some((update) => update.event === "change-suspected")).toBe(true);
  });

  it("recognizes silence and a sustained resume", () => {
    const detector = warmedDetector();
    const quiet = feed(detector, 8_250, 9_500, warm, 0.001);
    const resumed = feed(detector, 9_750, 11_250, bright);
    expect(quiet.some((update) => update.event === "silence")).toBe(true);
    expect(resumed.some((update) => update.event === "music-resumed")).toBe(true);
  });

  it("does not get stranded in silence when resumed music has brief quiet beats", () => {
    const detector = warmedDetector();
    feed(detector, 8_250, 9_500, warm, 0.001);
    const resumed = [];
    for (let at = 9_750; at <= 12_000; at += 250) {
      const quietBeat = at === 10_250 || at === 11_000 || at === 11_750;
      resumed.push(detector.push({ at, spectrum: bright, rms: quietBeat ? 0.004 : 0.08 }));
    }
    expect(resumed.some((update) => update.state === "resuming")).toBe(true);
    expect(resumed.some((update) => update.event === "music-resumed")).toBe(true);
  });

  it("arms on a sub-second track gap and recognizes the resumed song", () => {
    const detector = new AudioChangeDetector({ ...config, silenceMs: 650 });
    feed(detector, 0, 1_250, warm);
    detector.markRecognition(1_250, 0);
    feed(detector, 1_500, 8_000, warm);
    const gap = feed(detector, 8_250, 9_000, warm, 0.001);
    const resumed = feed(detector, 9_250, 10_750, bright);
    expect(gap.some((update) => update.event === "silence")).toBe(true);
    expect(resumed.some((update) => update.event === "music-resumed")).toBe(true);
  });
});
