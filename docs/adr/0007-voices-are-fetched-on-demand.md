# Voice models are fetched on demand, not bundled

No voice ships inside the app. The Piper *engine* still does — it is a binary, there is one
per platform, and it cannot be downloaded usefully at runtime. The *models* are fetched the
first time a render needs one, into `<userData>/piper-voices`, from a Hugging Face revision
pinned in both halves of the install path (`src/main/speech/voices.ts` at runtime,
`scripts/fetch-piper.mjs` at build time, which must agree).

This reverses part of the original decision behind ADR 0005, which bundled a default voice
per platform so that speech had "no key or network to fail on show night". That reasoning
still holds for the engine and for the *clips*; it does not survive contact with the models.
A model is 60–110MB, there are hundreds of them, and whichever we picked would sit in every
installer for a voice most operators change within a day. Two voices were bundled for a
while and neither was the one in use.

What ADR 0005 actually forbids is a *show* depending on a network. That is unchanged:
synthesis never runs during a Live session, and playback reads finished clips off local
disk. A download happens where rendering happens — ahead of the show, on a machine that
still has a network — and when it fails it fails then, loudly, with time to react.

Integrity is not traded away with the bundling. The catalogue revision is pinned to an
immutable commit, and every downloaded byte is checked against the digest that revision
publishes for it: `lfs.oid` (a SHA-256) for a model, the git blob SHA-1 for a config.

## Consequences

A brand-new install on a machine with no network cannot render its first clip. That is the
real cost of this decision and it is accepted: the affected moment is setup, not showtime.
An operator who needs to work offline can pin a voice back into `VOICES` in
`scripts/fetch-piper.mjs` and rebuild — the bundling machinery is kept working for exactly
that, and `bundledVoicesDir()` is still searched before the downloaded directory, so a
build-time copy wins over anything later written into userData.

Failing to obtain a voice is treated as the engine being unusable rather than as sixty-one
clip failures, and it latches: auto-render will not restart a hundred-megabyte download
every few seconds.

## Also recorded here: the breath before the countdown

`flush` placement was specified to schedule the phrase backwards from the first number so
the utterance is "one continuous sentence". In practice, exactly flush is not continuous —
it is slurred. Clip durations are measured to the last audible sample, so not even the
synthesiser's own trailing pad separates "Wokal za" from "3". `PHRASE_GAP_MS` (300ms, about
the length of a comma in speech) is now inserted between them.

The gap is deliberately *not* applied in the branch that flushes against the Call's own
start when no number survives: there is no following clip to run into there, and leaving it
alone keeps the "too short to announce" threshold where Edit mode badges it.
