# Feature: Lyrics Track

## Goal

A second Track on the timeline holding song text, so the operator can see where in the song
they are. Available in both Kinds of Rundown.

## Data model

```sql
CREATE TABLE lyrics (
  id         TEXT PRIMARY KEY,
  rundown_id TEXT NOT NULL REFERENCES rundowns(id) ON DELETE CASCADE,
  start_ms   INTEGER NOT NULL,
  end_ms     INTEGER NOT NULL,
  text       TEXT NOT NULL
);
CREATE INDEX idx_lyrics_rundown ON lyrics(rundown_id, start_ms);
```

Lines must be disjoint: no two Lyrics on a Rundown may overlap.

## Timeline

Exactly two Tracks, hard-coded: the item Track (Shots or Calls) and the Lyrics Track. There
is no generic multi-track system.

## Authoring

Line by line against Reference media, as in CuePilot: position the playhead, set **In**,
play, set **Out**, repeat. A Lyric is never spoken and never sent anywhere — it is an
orientation aid for the operator only.

## Acceptance criteria

- Lyrics render on their own lane in both Kinds.
- Overlapping in/out ranges are rejected.
- Deleting a Rundown deletes its Lyrics.
- `yarn test` passes.
