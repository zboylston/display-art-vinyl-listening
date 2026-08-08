export type DecodedWav = {
  samples: Float32Array;
  sampleRate: number;
  channels: number;
};

function readFourCC(view: DataView, offset: number) {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
}

/** Parse a mono (or first-channel) 16-bit PCM RIFF WAV into float samples in [-1, 1]. */
export function decodeMonoPcm16Wav(buffer: ArrayBuffer): DecodedWav {
  if (buffer.byteLength < 44) throw new Error("WAV capture is too short.");
  const view = new DataView(buffer);
  if (readFourCC(view, 0) !== "RIFF" || readFourCC(view, 8) !== "WAVE") {
    throw new Error("Expected a RIFF WAVE capture.");
  }

  let offset = 12;
  let sampleRate = 0;
  let channels = 0;
  let bitsPerSample = 0;
  let audioFormat = 0;
  let dataOffset = -1;
  let dataSize = 0;

  while (offset + 8 <= view.byteLength) {
    const chunkId = readFourCC(view, offset);
    const chunkSize = view.getUint32(offset + 4, true);
    const chunkData = offset + 8;
    if (chunkId === "fmt ") {
      audioFormat = view.getUint16(chunkData, true);
      channels = view.getUint16(chunkData + 2, true);
      sampleRate = view.getUint32(chunkData + 4, true);
      bitsPerSample = view.getUint16(chunkData + 14, true);
    } else if (chunkId === "data") {
      dataOffset = chunkData;
      dataSize = chunkSize;
      break;
    }
    offset = chunkData + chunkSize + (chunkSize % 2);
  }

  if (dataOffset < 0 || !sampleRate || !channels) throw new Error("WAV capture is missing audio data.");
  if (audioFormat !== 1) throw new Error("Only uncompressed PCM WAV is supported.");
  if (bitsPerSample !== 16) throw new Error("Only 16-bit PCM WAV is supported.");

  const bytesPerFrame = channels * 2;
  const frameCount = Math.floor(dataSize / bytesPerFrame);
  const samples = new Float32Array(frameCount);
  for (let frame = 0; frame < frameCount; frame += 1) {
    const sample = view.getInt16(dataOffset + frame * bytesPerFrame, true);
    samples[frame] = sample < 0 ? sample / 0x8000 : sample / 0x7fff;
  }
  return { samples, sampleRate, channels };
}

/** Average-decimate (or nearest-neighbor upsample) float audio to a target rate. */
export function resampleLinear(samples: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (!samples.length) return samples;
  if (fromRate === toRate) return samples;
  if (fromRate <= 0 || toRate <= 0) throw new Error("Invalid sample rate.");

  const ratio = fromRate / toRate;
  const length = Math.max(1, Math.floor(samples.length / ratio));
  const output = new Float32Array(length);

  if (ratio >= 1) {
    // Decimate by averaging each source window so 48 kHz → 16 kHz stays clean.
    for (let index = 0; index < length; index += 1) {
      const start = Math.floor(index * ratio);
      const end = Math.min(samples.length, Math.floor((index + 1) * ratio));
      if (end <= start) {
        output[index] = samples[Math.min(start, samples.length - 1)];
        continue;
      }
      let sum = 0;
      for (let cursor = start; cursor < end; cursor += 1) sum += samples[cursor];
      output[index] = sum / (end - start);
    }
    return output;
  }

  for (let index = 0; index < length; index += 1) {
    const position = index * ratio;
    const left = Math.floor(position);
    const right = Math.min(samples.length - 1, left + 1);
    const mix = position - left;
    output[index] = samples[left] * (1 - mix) + samples[right] * mix;
  }
  return output;
}

/** Convert float samples in [-1, 1] to signed 16-bit little-endian PCM bytes. */
export function floatToS16le(samples: Float32Array): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < samples.length; index += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[index]));
    view.setInt16(index * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  }
  return bytes;
}
