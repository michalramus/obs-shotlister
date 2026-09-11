# Live progress is never persisted

A Live session's progress — the Live queue, which Shot is live, when it went live, and
whether it is running — is held in memory only. Only the *selection* (which Rundown and
Project are active) is stored in the `live_state` row.

The alternative was persisting progress so a crashed or restarted app could resume mid-show.
We rejected it: resuming into a stale live state is more dangerous than starting clean,
because the app would drive OBS from a position that no longer matches what is on air. A
show that has lost its operator's machine is being re-started by a human either way.

## Consequences

Anything reading live progress must read it from memory. Progress columns do not exist in
the schema, and a query for them fails at runtime rather than at compile time — this has
already caused one silent bug, where the OSC transition guard queried dropped columns,
threw, was swallowed by a `catch`, and returned `false` for every transition. The live
session module exists to make that class of mistake impossible.
