"use client";

import { useEffect, useRef, useState } from "react";
import { encodeMonoWav, prepareRecognitionAudio } from "../lib/wav";

type AudioInput = { deviceId: string; label: string };
type Capture = {
  rawUrl: string;
  conditionedUrl: string;
  rawStats: string;
  conditionedStats: string;
  conditionedBlob: Blob;
};

const CAPTURE_SECONDS = 10;

function rmsOf(samples: Float32Array) {
  if (!samples.length) return 0;
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return Math.sqrt(sum / samples.length);
}

export default function MicTestPage() {
  const [status, setStatus] = useState("Pick a microphone, then start.");
  const [inputs, setInputs] = useState<AudioInput[]>([]);
  const [deviceId, setDeviceId] = useState("");
  const [listening, setListening] = useState(false);
  const [level, setLevel] = useState(0);
  const [settingsLines, setSettingsLines] = useState<string[]>([]);
  const [capture, setCapture] = useState<Capture | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [identifyResult, setIdentifyResult] = useState("");
  const [identifying, setIdentifying] = useState(false);

  const streamRef = useRef<MediaStream | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const workletRef = useRef<AudioWorkletNode | null>(null);
  const waveformRef = useRef<Float32Array<ArrayBuffer> | null>(null);
  const meterIntervalRef = useRef<number | null>(null);
  const snapshotRequestIdRef = useRef(0);
  const snapshotRequestsRef = useRef(new Map<number, { resolve: (value: { samples: Float32Array; sampleRate: number }) => void; reject: (error: Error) => void; timeout: number }>());

  useEffect(() => {
    void navigator.mediaDevices?.enumerateDevices().then((devices) => setInputs(devices
      .filter((device) => device.kind === "audioinput")
      .map((device, index) => ({ deviceId: device.deviceId, label: device.label || `Microphone ${index + 1}` })))).catch(() => undefined);
    return () => stopMic();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function stopMic() {
    if (meterIntervalRef.current) window.clearInterval(meterIntervalRef.current);
    meterIntervalRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    workletRef.current?.disconnect();
    workletRef.current = null;
    analyserRef.current = null;
    waveformRef.current = null;
    void contextRef.current?.close();
    contextRef.current = null;
    setListening(false);
    setLevel(0);
  }

  async function startMic() {
    stopMic();
    setCapture(null);
    setIdentifyResult("");
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setStatus("Microphone needs HTTPS (or localhost). Open this page via the deployed https URL on the TV.");
      return;
    }
    try {
      // Same constraints as the main app's listen mode — the point is to see
      // what this browser actually applies vs what we ask for.
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: deviceId ? { exact: deviceId } : undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: true, channelCount: 1, sampleRate: 48_000 },
      });
      streamRef.current = stream;
      const track = stream.getAudioTracks()[0];
      const settings = track?.getSettings() ?? {};
      const context = new AudioContext();
      await context.resume();
      contextRef.current = context;
      setSettingsLines([
        `label: ${track?.label ?? "unknown"}`,
        `sampleRate: context ${context.sampleRate}Hz · track ${settings.sampleRate ?? "?"}Hz (asked 48000)`,
        `channelCount: ${settings.channelCount ?? "?"} (asked 1)`,
        `echoCancellation: ${String(settings.echoCancellation)} (asked false)`,
        `noiseSuppression: ${String(settings.noiseSuppression)} (asked false)`,
        `autoGainControl: ${String(settings.autoGainControl)} (asked true)`,
        `ua: ${navigator.userAgent}`,
      ]);

      const analyser = context.createAnalyser();
      analyser.fftSize = 2048;
      const source = context.createMediaStreamSource(stream);
      source.connect(analyser);
      analyserRef.current = analyser;
      waveformRef.current = new Float32Array(analyser.fftSize);

      try {
        await context.audioWorklet.addModule("/audio-ring-buffer-worklet.js?v=24s-eq");
        const worklet = new AudioWorkletNode(context, "audio-ring-buffer", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
        const silentGain = context.createGain();
        silentGain.gain.value = 0;
        source.connect(worklet);
        worklet.connect(silentGain);
        silentGain.connect(context.destination);
        worklet.port.onmessage = (event: MessageEvent<{ type?: string; requestId?: number; sampleRate?: number; samples?: ArrayBuffer }>) => {
          const message = event.data;
          if (message.type !== "snapshot" || message.requestId === undefined || !message.samples || !message.sampleRate) return;
          const pending = snapshotRequestsRef.current.get(message.requestId);
          if (!pending) return;
          window.clearTimeout(pending.timeout);
          snapshotRequestsRef.current.delete(message.requestId);
          pending.resolve({ samples: new Float32Array(message.samples), sampleRate: message.sampleRate });
        };
        workletRef.current = worklet;
      } catch {
        setStatus("AudioWorklet unavailable on this browser — live meter works, but capture/identify need the worklet.");
      }

      meterIntervalRef.current = window.setInterval(() => {
        const node = analyserRef.current;
        const waveform = waveformRef.current;
        if (!node || !waveform) return;
        node.getFloatTimeDomainData(waveform);
        setLevel(rmsOf(waveform));
      }, 250);

      setListening(true);
      setStatus(workletRef.current
        ? "Listening. Play music — the meter should move clearly. Then capture 10s."
        : "Listening (meter only — no worklet on this browser).");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Microphone access failed.");
    }
  }

  function takeSnapshot(seconds: number): Promise<{ samples: Float32Array; sampleRate: number }> {
    const worklet = workletRef.current;
    if (!worklet) return Promise.reject(new Error("Audio ring buffer is unavailable."));
    const requestId = ++snapshotRequestIdRef.current;
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        snapshotRequestsRef.current.delete(requestId);
        reject(new Error("Snapshot timed out."));
      }, 2_000);
      snapshotRequestsRef.current.set(requestId, { resolve, reject, timeout });
      worklet.port.postMessage({ type: "snapshot", requestId, seconds });
    });
  }

  async function captureSample() {
    if (!workletRef.current || capturing) return;
    setCapturing(true);
    setIdentifyResult("");
    setStatus(`Capturing the last ${CAPTURE_SECONDS}s…`);
    try {
      const snapshot = await takeSnapshot(CAPTURE_SECONDS);
      if (snapshot.samples.length < snapshot.sampleRate * 4) throw new Error("Not enough audio yet — let it listen longer first.");

      const rawBlob = encodeMonoWav(snapshot.samples, snapshot.sampleRate);
      const rawRms = rmsOf(snapshot.samples);
      let rawPeak = 0;
      for (const sample of snapshot.samples) rawPeak = Math.max(rawPeak, Math.abs(sample));

      // Same conditioning the recognition pipeline applies for vinyl captures.
      const prepared = prepareRecognitionAudio(snapshot.samples, snapshot.sampleRate, true, 0.14, 18);
      const conditionedBlob = encodeMonoWav(prepared.samples, snapshot.sampleRate);

      if (capture) {
        URL.revokeObjectURL(capture.rawUrl);
        URL.revokeObjectURL(capture.conditionedUrl);
      }
      setCapture({
        rawUrl: URL.createObjectURL(rawBlob),
        conditionedUrl: URL.createObjectURL(conditionedBlob),
        rawStats: `rms ${rawRms.toFixed(4)} · peak ${rawPeak.toFixed(3)} · ${(snapshot.samples.length / snapshot.sampleRate).toFixed(1)}s @ ${snapshot.sampleRate}Hz`,
        conditionedStats: `rms ${prepared.inputRms.toFixed(4)} → ${prepared.outputRms.toFixed(3)} · gain ${prepared.gain.toFixed(1)}× · peak ${prepared.peak.toFixed(3)}`,
        conditionedBlob,
      });
      setStatus("Capture ready — play both clips below.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Capture failed.");
    } finally {
      setCapturing(false);
    }
  }

  async function identifyCapture() {
    if (!capture || identifying) return;
    setIdentifying(true);
    setIdentifyResult("");
    setStatus("Identifying the conditioned clip…");
    try {
      const form = new FormData();
      form.append("audio", capture.conditionedBlob, "mic-test.wav");
      form.append("mode", "live");
      const response = await fetch("/api/recognize", { method: "POST", body: form, signal: AbortSignal.timeout(40_000) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setIdentifyResult(`error ${response.status}: ${data.error ?? "unknown"}`);
      } else if (!data.result) {
        setIdentifyResult(`no match${data.warning ? ` — ${data.warning}` : ""} (provider: ${data.provider ?? "?"})`);
      } else {
        setIdentifyResult(`match: ${data.result.artist} — ${data.result.title} (${data.result.album}) [provider: ${data.provider ?? "?"}]`);
      }
      setStatus("Done.");
    } catch (error) {
      setIdentifyResult(error instanceof Error ? error.message : "Identify failed.");
      setStatus("Identify failed.");
    } finally {
      setIdentifying(false);
    }
  }

  const levelPercent = Math.min(100, Math.round(level * 400));
  const levelColor = level < 0.012 ? "#b0563f" : level < 0.05 ? "#c99776" : "#8ba05e";

  return (
    <main style={{ minHeight: "100vh", background: "#1b1813", color: "#f6f0e6", padding: "4vh 6vw", fontFamily: "Inter, sans-serif" }}>
      <p style={{ textTransform: "uppercase", letterSpacing: ".22em", fontSize: ".8rem", opacity: .7 }}>Needle & Frame · mic test</p>
      <h1 style={{ fontFamily: '"Cormorant Garamond", Georgia, serif', fontWeight: 500, fontSize: "clamp(2rem,5vw,3.5rem)", margin: ".2em 0 .5em" }}>What does this mic actually hear?</h1>

      <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap", alignItems: "center", marginBottom: "1.5rem" }}>
        <select
          value={deviceId}
          onChange={(event) => setDeviceId(event.target.value)}
          style={{ background: "#26221c", color: "inherit", border: "1px solid rgba(255,255,255,.25)", borderRadius: 8, padding: ".7rem 1rem", font: "inherit" }}
        >
          <option value="">Default microphone</option>
          {inputs.map((input) => <option key={input.deviceId} value={input.deviceId}>{input.label}</option>)}
        </select>
        <button type="button" onClick={() => void startMic()} style={{ border: "1px solid currentColor", background: "transparent", color: "inherit", borderRadius: 100, padding: ".7rem 1.4rem", font: "inherit", cursor: "pointer", margin: 0 }}>
          {listening ? "Restart mic" : "Start mic"}
        </button>
        {listening && (
          <button type="button" onClick={stopMic} style={{ border: "1px solid currentColor", background: "transparent", color: "inherit", borderRadius: 100, padding: ".7rem 1.4rem", font: "inherit", cursor: "pointer", margin: 0 }}>
            Stop
          </button>
        )}
      </div>

      <p style={{ opacity: .8 }}>{status}</p>

      {listening && (
        <section style={{ margin: "1.5rem 0", padding: "1rem 1.25rem", border: "1px solid rgba(255,255,255,.15)", borderRadius: 12 }}>
          <p style={{ margin: "0 0 .6rem", textTransform: "uppercase", letterSpacing: ".15em", fontSize: ".75rem", opacity: .7 }}>
            Live level — rms {level.toFixed(4)} {level < 0.012 ? "(below detector threshold 0.012)" : ""}
          </p>
          <div style={{ height: 18, borderRadius: 9, background: "rgba(255,255,255,.08)", overflow: "hidden" }}>
            <div style={{ width: `${levelPercent}%`, height: "100%", background: levelColor, transition: "width .2s" }} />
          </div>
          <button
            type="button"
            disabled={!workletRef.current || capturing}
            onClick={() => void captureSample()}
            style={{ marginTop: "1rem", border: "1px solid currentColor", background: "transparent", color: "inherit", borderRadius: 100, padding: ".7rem 1.4rem", font: "inherit", cursor: "pointer" }}
          >
            {capturing ? "Capturing…" : `Capture last ${CAPTURE_SECONDS}s`}
          </button>
        </section>
      )}

      {settingsLines.length > 0 && (
        <section style={{ margin: "1.5rem 0", padding: "1rem 1.25rem", border: "1px solid rgba(255,255,255,.15)", borderRadius: 12 }}>
          <p style={{ margin: "0 0 .6rem", textTransform: "uppercase", letterSpacing: ".15em", fontSize: ".75rem", opacity: .7 }}>What the browser applied</p>
          <pre style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word", font: "500 .8rem/1.6 ui-monospace, Menlo, monospace", opacity: .9 }}>
            {settingsLines.join("\n")}
          </pre>
        </section>
      )}

      {capture && (
        <section style={{ margin: "1.5rem 0", display: "grid", gap: "1rem" }}>
          <div style={{ padding: "1rem 1.25rem", border: "1px solid rgba(255,255,255,.15)", borderRadius: 12 }}>
            <p style={{ margin: "0 0 .4rem", textTransform: "uppercase", letterSpacing: ".15em", fontSize: ".75rem", opacity: .7 }}>1 · Raw capture (what the mic heard)</p>
            <p style={{ margin: "0 0 .6rem", font: "500 .8rem/1.4 ui-monospace, Menlo, monospace", opacity: .8 }}>{capture.rawStats}</p>
            <audio controls src={capture.rawUrl} style={{ width: "100%" }} />
            <p style={{ margin: ".6rem 0 0", fontSize: ".85rem", opacity: .75 }}>
              <a href={capture.rawUrl} download="mic-test-raw.wav" style={{ color: "#c99776" }}>download raw</a>
            </p>
          </div>
          <div style={{ padding: "1rem 1.25rem", border: "1px solid rgba(255,255,255,.15)", borderRadius: 12 }}>
            <p style={{ margin: "0 0 .4rem", textTransform: "uppercase", letterSpacing: ".15em", fontSize: ".75rem", opacity: .7 }}>2 · Conditioned (exactly what recognition receives)</p>
            <p style={{ margin: "0 0 .6rem", font: "500 .8rem/1.4 ui-monospace, Menlo, monospace", opacity: .8 }}>{capture.conditionedStats}</p>
            <audio controls src={capture.conditionedUrl} style={{ width: "100%" }} />
            <p style={{ margin: ".6rem 0 0", fontSize: ".85rem", opacity: .75 }}>
              <a href={capture.conditionedUrl} download="mic-test-conditioned.wav" style={{ color: "#c99776" }}>download conditioned</a>
            </p>
          </div>
          <div style={{ padding: "1rem 1.25rem", border: "1px solid rgba(255,255,255,.15)", borderRadius: 12 }}>
            <p style={{ margin: "0 0 .6rem", textTransform: "uppercase", letterSpacing: ".15em", fontSize: ".75rem", opacity: .7 }}>3 · Identify the conditioned clip</p>
            <button
              type="button"
              disabled={identifying}
              onClick={() => void identifyCapture()}
              style={{ border: "1px solid currentColor", background: "transparent", color: "inherit", borderRadius: 100, padding: ".7rem 1.4rem", font: "inherit", cursor: "pointer", margin: 0 }}
            >
              {identifying ? "Identifying…" : "Identify this clip"}
            </button>
            {identifyResult && <p style={{ margin: ".8rem 0 0", font: "500 .9rem/1.5 ui-monospace, Menlo, monospace" }}>{identifyResult}</p>}
          </div>
        </section>
      )}

      <section style={{ marginTop: "2rem", padding: "1rem 1.25rem", border: "1px solid rgba(255,255,255,.1)", borderRadius: 12, opacity: .8, fontSize: ".9rem", lineHeight: 1.6 }}>
        <strong>How to read the result:</strong> raw clip quiet or garbled → mic or TV audio stack.
        Raw fine but conditioned distorted → conditioning problem. Both sound like the song but
        identify fails → recognition/provider, not the mic. If the browser-applied settings above
        ignored our constraints (echo cancellation on, 44.1kHz, stereo), that points at the TV browser.
      </section>
    </main>
  );
}
