import { describe, expect, it } from "vitest";
import { encodeMonoWav, prepareRecognitionAudio } from "./wav";

describe("prepareRecognitionAudio", () => {
  it("raises a quiet capture to a fingerprint-friendly level without clipping", () => {
    const input = Float32Array.from({ length: 48_000 }, (_, index) => index % 2 ? 0.02 : -0.02);
    const prepared = prepareRecognitionAudio(input);
    expect(prepared.inputRms).toBeCloseTo(0.02, 3);
    expect(prepared.outputRms).toBeCloseTo(0.12, 3);
    expect(prepared.gain).toBeCloseTo(6, 2);
    expect(prepared.peak).toBeLessThanOrEqual(0.92);
  });

  it("removes microphone DC offset", () => {
    const input = Float32Array.from({ length: 1000 }, (_, index) => 0.2 + (index % 2 ? 0.02 : -0.02));
    const prepared = prepareRecognitionAudio(input);
    const mean = prepared.samples.reduce((sum, sample) => sum + sample, 0) / prepared.samples.length;
    expect(mean).toBeCloseTo(0, 5);
  });

  it("can condition a bass-heavy retry while remaining peak safe", () => {
    const input = Float32Array.from({ length: 48_000 }, (_, index) => (
      0.08 * Math.sin(2 * Math.PI * 45 * index / 48_000)
      + 0.01 * Math.sin(2 * Math.PI * 2_000 * index / 48_000)
    ));
    const prepared = prepareRecognitionAudio(input, 48_000, true);
    expect(prepared.conditioned).toBe(true);
    expect(prepared.peak).toBeLessThanOrEqual(0.92);
    expect(prepared.samples).not.toEqual(input);
  });
});

describe("encodeMonoWav", () => {
  it("writes a valid mono 16-bit PCM header", async () => {
    const blob = encodeMonoWav(new Float32Array([0, 0.5, -0.5]), 48_000);
    const view = new DataView(await blob.arrayBuffer());
    expect(blob.type).toBe("audio/wav");
    expect(String.fromCharCode(...new Uint8Array(view.buffer, 0, 4))).toBe("RIFF");
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(48_000);
    expect(view.getUint16(34, true)).toBe(16);
  });
});
