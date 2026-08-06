export type PreparedRecognitionAudio = {
  samples: Float32Array;
  inputRms: number;
  outputRms: number;
  peak: number;
  gain: number;
  conditioned: boolean;
};

function rms(samples: Float32Array) {
  if (!samples.length) return 0;
  let power = 0;
  for (const sample of samples) power += sample * sample;
  return Math.sqrt(power / samples.length);
}

/** Remove DC offset and safely lift quiet room captures before fingerprinting. */
export function prepareRecognitionAudio(
  input: Float32Array,
  sampleRate = 48_000,
  conditionFingerprint = false,
  targetRms = 0.12,
  maxGain = 12,
): PreparedRecognitionAudio {
  if (!input.length) return { samples: input, inputRms: 0, outputRms: 0, peak: 0, gain: 1, conditioned: conditionFingerprint };
  let mean = 0;
  for (const sample of input) mean += sample;
  mean /= input.length;

  const centered = new Float32Array(input.length);
  const highPassAlpha = 1 / (1 + (2 * Math.PI * 100) / sampleRate);
  let previousInput = 0;
  let previousHighPass = 0;
  let peak = 0;
  for (let index = 0; index < input.length; index += 1) {
    const sample = input[index] - mean;
    if (conditionFingerprint) {
      const highPass = highPassAlpha * (previousHighPass + sample - previousInput);
      // A gentle pre-emphasis prevents low room rumble from consuming the
      // normalization headroom needed by AudD's mid/high-frequency landmarks.
      centered[index] = highPass - 0.35 * previousHighPass;
      previousInput = sample;
      previousHighPass = highPass;
    } else centered[index] = sample;
    peak = Math.max(peak, Math.abs(centered[index]));
  }
  const inputRms = rms(centered);
  const rmsGain = inputRms > 0 ? targetRms / inputRms : 1;
  const peakGain = peak > 0 ? 0.92 / peak : 1;
  const gain = Math.max(0, Math.min(maxGain, rmsGain, peakGain));
  for (let index = 0; index < centered.length; index += 1) centered[index] *= gain;
  return { samples: centered, inputRms, outputRms: rms(centered), peak: peak * gain, gain, conditioned: conditionFingerprint };
}

export function encodeMonoWav(samples: Float32Array, sampleRate: number): Blob {
  const bytesPerSample = 2;
  const buffer = new ArrayBuffer(44 + samples.length * bytesPerSample);
  const view = new DataView(buffer);
  const write = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
  };

  write(0, "RIFF");
  view.setUint32(4, 36 + samples.length * bytesPerSample, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, samples.length * bytesPerSample, true);

  let offset = 44;
  for (const sample of samples) {
    const clamped = Math.max(-1, Math.min(1, sample));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += bytesPerSample;
  }
  return new Blob([buffer], { type: "audio/wav" });
}
