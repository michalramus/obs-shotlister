# Announcements are pre-rendered; nothing is synthesised during a Live session

Voice-over Rundowns speak a Part's name and a countdown. All of that audio is synthesised
ahead of the show into a content-addressed cache keyed on (text, Voice, engine), and a Live
session does nothing but play and concatenate existing files. Speech synthesis never runs
while a show is running.

The alternative — synthesising on demand — was rejected on two counts. It puts unbounded
latency in front of an utterance that has to land on a specific second, and it puts CPU load
on the machine driving OBS, which is the one machine that cannot afford a spike. The same
reasoning rules out doing the rendering on the Cue Tray's switcher machine.

## Consequences

A Part therefore has a Render state, and the UI has to surface *stale* and *never rendered*
before a show rather than discovering them during one. Starting a Live session with
unrendered Parts warns but does not block, matching ADR 0002's refusal to let the system
override the operator. Because the cache is content-addressed, editing a Part's name orphans
its old clips; the cache is swept on app start and on app close only, never while a session
may be running.

Countdown numbers are rendered 1..60 per Voice unconditionally, so changing which numbers a
countdown uses is a settings change that can never require a re-render.
