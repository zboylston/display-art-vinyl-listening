# Evaluation fixtures

Each track uses two files when available:

- `fixtures/<provider>/<track>.raw.json` — a sanitized, captured provider response
- `fixtures/<provider>/<track>.normalized.json` — the provider-neutral event used by the app

Keep test audio in `local-audio/`. It must not be committed.

The first fixture is a captured AudD result for Nick Drake's “Pink Moon.”
`fixtures/shazam/i-will-survive.raw.json` is a captured Shazam discovery payload used by the mapper unit test.

## Provider A/B

`/api/recognize` selects AudD or Shazam via `RECOGNITION_PROVIDER` (default `audd`) or a multipart `provider` field.

```bash
# Compare Node Shazam against Python ShazamIO on the Gloria clip
source scripts/shazamio-smoke/.venv/bin/activate
python scripts/shazamio-smoke/compare.py

# Replay every WAV in evals/local-audio/ through both providers
python scripts/shazamio-smoke/replay.py
```
