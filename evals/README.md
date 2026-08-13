# Evaluation fixtures

Each track uses two files when available:

- `fixtures/<provider>/<track>.raw.json` — a sanitized, captured provider response
- `fixtures/<provider>/<track>.normalized.json` — the provider-neutral event used by the app

Keep test audio in `local-audio/`. It must not be committed.

The first fixture is a captured AudD result for Nick Drake's “Pink Moon.”
`fixtures/shazam/i-will-survive.raw.json` is a captured Shazam discovery payload used by the mapper unit test.

## Curation regressions

`fixtures/curation/*.json` records reported song-to-artwork mismatches so a fix can be verified instead of argued about. Each case holds the track, the brief axes it should have produced, and three buckets of artworks with their measured tone:

- `rejected` — must register a hard tone conflict and be demoted out of the pool
- `tolerated` — must register a soft conflict only, which pins the thresholds from the other side
- `preferred` — must register no conflict

`curation/valence-regression.test.ts` runs every case offline through `app/lib/art-tone.ts`; no API keys or network are needed.

To add a case, take the artwork's real numbers rather than estimating them. `[curate] selection` logs the measured tone of a served work, and `scripts/measure-artwork.mjs "<title>"` measures any Met artwork by title.

## Provider A/B

`/api/recognize` selects AudD or Shazam via `RECOGNITION_PROVIDER` (default `audd`) or a multipart `provider` field.

```bash
# Compare Node Shazam against Python ShazamIO on the Gloria clip
source scripts/shazamio-smoke/.venv/bin/activate
python scripts/shazamio-smoke/compare.py

# Replay every WAV in evals/local-audio/ through both providers
python scripts/shazamio-smoke/replay.py
```
