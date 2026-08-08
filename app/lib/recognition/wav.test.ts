import { describe, expect, it } from "vitest";
import { encodeMonoWav } from "../wav";
import { decodeMonoPcm16Wav, floatToS16le, resampleLinear } from "./wav";

describe("decodeMonoPcm16Wav", () => {
  it("round-trips a mono 16-bit WAV written by encodeMonoWav", async () => {
    const source = new Float32Array([0, 0.5, -0.5, 0.25]);
    const blob = encodeMonoWav(source, 48_000);
    const decoded = decodeMonoPcm16Wav(await blob.arrayBuffer());
    expect(decoded.sampleRate).toBe(48_000);
    expect(decoded.channels).toBe(1);
    expect(decoded.samples.length).toBe(4);
    expect(decoded.samples[0]).toBeCloseTo(0, 4);
    expect(decoded.samples[1]).toBeCloseTo(0.5, 3);
    expect(decoded.samples[2]).toBeCloseTo(-0.5, 3);
    expect(decoded.samples[3]).toBeCloseTo(0.25, 3);
  });

  it("rejects non-WAV payloads", () => {
    const junk = new TextEncoder().encode("not a wav file payload long enough to pass the size gate").buffer;
    expect(() => decodeMonoPcm16Wav(junk)).toThrow(/RIFF WAVE/);
  });
});

describe("resampleLinear", () => {
  it("average-decimates 48 kHz to 16 kHz by a factor of three", () => {
    const source = Float32Array.from({ length: 48 }, (_, index) => index % 3 === 0 ? 1 : index % 3 === 1 ? 0 : -1);
    const resampled = resampleLinear(source, 48_000, 16_000);
    expect(resampled.length).toBe(16);
    // Each output sample averages one 1, one 0, and one -1.
    for (const sample of resampled) expect(sample).toBeCloseTo(0, 5);
  });

  it("returns the same buffer when rates match", () => {
    const source = new Float32Array([0.1, 0.2]);
    expect(resampleLinear(source, 16_000, 16_000)).toBe(source);
  });
});

describe("floatToS16le", () => {
  it("writes little-endian int16 samples", () => {
    const bytes = floatToS16le(new Float32Array([0, 1, -1]));
    const view = new DataView(bytes.buffer);
    expect(view.getInt16(0, true)).toBe(0);
    expect(view.getInt16(2, true)).toBe(0x7fff);
    expect(view.getInt16(4, true)).toBe(-0x8000);
  });
});
