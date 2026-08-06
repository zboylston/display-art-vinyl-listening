# Needle & Frame

Artwork curation uses a landscape-first, museum-verified comparative funnel. A nuanced visual brief and anti-brief generate ten diversified searches across the Met, Cleveland Museum of Art, and Art Institute of Chicago. Up to eighteen actual candidate images are judged in comparative semifinals; the six finalists are then scored for emotional and thematic resonance, television-scale composition, originality, cultural connection, provenance, and explicit cliché penalties. The API response includes the winner and two alternatives.

An art-first television experience for music listening.

## Listening modes

**Live mode** uses local spectral and silence detection to follow arbitrary playback, calling AudD only when the local gate suspects a meaningful transition.

**Vinyl mode** identifies the playing track once, resolves its ordered Apple catalog album sequence, estimates the current track ending from AudD's timecode, and begins curating the next track in the background. A track gap, a near-boundary spectral change, or the predicted ending advances immediately to the preloaded artwork. Mid-track pauses freeze the prediction; an unexpected change re-runs AudD to handle a moved needle, skipped track, or mismatched pressing. Timer-only transitions receive a delayed confirmation check, while clean predicted gaps advance without another recognition call.

This repository begins with replayable provider fixtures and the three-act TV display prototype. The original product context remains in the sibling `music-art-context` directory until it is deliberately incorporated here.

## Current contents

- `evals/fixtures/audd/` — sanitized AudD recognition responses used for deterministic replay
- `evals/local-audio/` — local-only copyright-protected capture clips; ignored by Git

## Song-change detection

Listen mode uses a low-resource local gate before calling AudD:

1. An `AudioWorklet` continuously retains the latest 24 seconds of mono PCM in memory.
2. Four times per second, the browser reduces the FFT to 16 normalized logarithmic bands.
3. The detector compares a recent four-second window with an older non-overlapping baseline. A change must remain above the threshold for 2.75 seconds before it can trigger recognition.
4. A track gap of roughly 0.65 seconds arms resume detection; after five seconds of new music, only that post-gap audio is uploaded. The expected track ending (when AudD supplies duration/timecode) and a two-minute safety check can also trigger recognition.
5. In-flight and cooldown gates prevent overlapping calls. ISRC, or normalized artist/title when ISRC is absent, suppresses duplicate presentation and curation.

Initial discovery waits for a full 15-second recording. In Vinyl mode, the first miss schedules a fresh 24-second clip with gentle high-pass and pre-emphasis conditioning ten seconds later; this keeps room rumble from masking fingerprint landmarks. Later misses continue using fresh 24-second windows. After a song has been identified, transition misses use a 12-second retry, then 30 seconds, then back off to the two-minute safety interval. The ready screen exposes the browser's actual microphone choices so the capture can use the same input that succeeds in another recorder. If `AudioWorklet` is unavailable, listen mode automatically uses the prior `MediaRecorder` capture path.

After a successful AudD match, the server performs one lightweight exact artist/title catalog lookup. Original-album results are preferred over compilations, greatest-hits releases, sample collections, and DJ mixes; the resolved album title and high-resolution cover are returned together. If no cover can be verified, the client shows a neutral album placeholder instead of reusing the previous song's artwork.

### Tuning and diagnostics

Open `/?debugAudio=1` to show detector state, cosine-change score, RMS, trigger reason, and the number of AudD calls made during the current page session. Default thresholds live in `app/lib/audio-change-detector.ts`. Useful real-room tuning targets are:

- Stable song and volume changes: comfortably below `changeThreshold` (`0.12` by default).
- Spoken interludes or short loud passages: they should recover before `sustainedMs` (`2750ms`).
- Real track transitions: above the threshold for at least the sustained interval.

Set `USE_AUDIO_CHANGE_DETECTOR` to `false` in `app/page.tsx` to roll back to a 30-second periodic compatibility check while retaining request cooldown and deduplication.

## Artwork orientation

The curation funnel measures each verified image before model selection. If any landscape work (aspect ratio `1.12` or wider) is available, portrait and square candidates are removed from the selection pool. Square, unknown-dimension, and portrait works are used only as progressively weaker fallbacks when no verified landscape candidate exists. Landscape candidates closest to 16:9 are presented to the curator first.

## Artwork sources

Curation searches three open-access museum collections concurrently:

- The Metropolitan Museum of Art
- Cleveland Museum of Art
- Art Institute of Chicago

Only works explicitly marked public domain or CC0 are admitted. Provider records are normalized into one candidate shape, duplicate artist/title records are removed, and candidates are round-robin balanced by museum before visual selection so a larger collection cannot crowd out the others. Cleveland and Chicago supply image dimensions directly; final curator thumbnails are fetched server-side and sent as small embedded images so museum image-host restrictions do not break selection. The API response retains the museum source, collection record URL, rights label, and measured aspect ratio.
