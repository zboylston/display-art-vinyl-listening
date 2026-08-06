class AudioRingBufferProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samples = new Float32Array(Math.ceil(sampleRate * 24));
    this.writeIndex = 0;
    this.filled = 0;
    this.port.onmessage = (event) => {
      if (event.data?.type !== "snapshot") return;
      const requested = Math.floor(sampleRate * Math.max(1, Math.min(24, event.data.seconds || 15)));
      const length = Math.min(this.filled, requested);
      const result = new Float32Array(length);
      const start = (this.writeIndex - length + this.samples.length) % this.samples.length;
      const firstLength = Math.min(length, this.samples.length - start);
      result.set(this.samples.subarray(start, start + firstLength), 0);
      if (firstLength < length) result.set(this.samples.subarray(0, length - firstLength), firstLength);
      this.port.postMessage({ type: "snapshot", requestId: event.data.requestId, sampleRate, samples: result.buffer }, [result.buffer]);
    };
  }

  process(inputs) {
    const channels = inputs[0];
    if (!channels?.length) return true;
    for (let frame = 0; frame < channels[0].length; frame += 1) {
      let mono = 0;
      for (const channel of channels) mono += channel[frame] || 0;
      this.samples[this.writeIndex] = mono / channels.length;
      this.writeIndex = (this.writeIndex + 1) % this.samples.length;
      this.filled = Math.min(this.samples.length, this.filled + 1);
    }
    return true;
  }
}

registerProcessor("audio-ring-buffer", AudioRingBufferProcessor);
