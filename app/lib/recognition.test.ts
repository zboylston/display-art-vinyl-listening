import { describe, expect, it } from "vitest";
import { canonicalTrackKey, noMatchRetryDelay, RecognitionGate, textTrackKey } from "./recognition";

describe("canonicalTrackKey", () => {
  it("uses ISRC when available", () => {
    expect(canonicalTrackKey({ isrc: " us-abc-12-34567 ", artist: "A", title: "B" })).toBe("isrc:US-ABC-12-34567");
  });

  it("deduplicates punctuation and casing without relying on album metadata", () => {
    expect(canonicalTrackKey({ artist: "Beyoncé", title: "Hello!" }))
      .toBe(canonicalTrackKey({ artist: "BEYONCE", title: "hello" }));
  });
});

describe("textTrackKey", () => {
  it("ignores ISRC so vinyl sequence tracks match AudD results", () => {
    expect(textTrackKey({ isrc: "US-ABC-12-34567", artist: "Hiss Golden Messenger", title: "In the Middle of It" }))
      .toBe(textTrackKey({ artist: "Hiss Golden Messenger", title: "In the Middle of It" }));
  });
});

describe("RecognitionGate", () => {
  it("blocks overlapping requests and observes cooldown", () => {
    const gate = new RecognitionGate();
    expect(gate.tryStart(1_000)).toBe(true);
    expect(gate.tryStart(1_001)).toBe(false);
    gate.finish(2_000, 5_000);
    expect(gate.tryStart(6_999)).toBe(false);
    expect(gate.tryStart(7_000)).toBe(true);
  });

  it("force-starts past cooldown for vinyl post-advance verifies", () => {
    const gate = new RecognitionGate();
    expect(gate.tryStart(1_000)).toBe(true);
    gate.finish(2_000, 15_000);
    expect(gate.tryStart(3_000)).toBe(false);
    expect(gate.tryStartForced()).toBe(true);
    expect(gate.tryStartForced()).toBe(false);
  });
});

describe("noMatchRetryDelay", () => {
  it("keeps trying every ten seconds until the first song is confirmed", () => {
    expect(noMatchRetryDelay(false, 1)).toBe(10_000);
    expect(noMatchRetryDelay(false, 8)).toBe(10_000);
  });

  it("backs off after a song has already been confirmed", () => {
    expect(noMatchRetryDelay(true, 1)).toBe(12_000);
    expect(noMatchRetryDelay(true, 2)).toBe(30_000);
    expect(noMatchRetryDelay(true, 3)).toBe(120_000);
  });
});
