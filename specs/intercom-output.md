# Feature: Intercom output

## Dependencies

- `specs/voice-over-rundowns.md` — the Announcement playback and output-device selectors this
  extends
- ADR 0008 — why the Virtual output is created on Linux and only found elsewhere

## Goal

Get everything the show produces — every Cue and every Announcement — into an intercom, by
playing it a second time into a loopback device that a voice-chat client (Mumble) can select as
its input.

The operator keeps hearing everything. The Intercom output **duplicates**; it never moves sound
off the operator's speakers.

## The Virtual output

Named **Shotlister Out**. Where it comes from depends on the platform (ADR 0008).

| Platform | Source | Recorded in the intercom client as |
|---|---|---|
| Linux (PipeWire / PulseAudio) | Created by the app: `module-null-sink`, `sink_name=shotlister_out` | *Monitor of Shotlister Out* |
| macOS | BlackHole or Loopback, installed by the operator | that device's own input |
| Windows | VB-CABLE or VoiceMeeter, installed by the operator | that device's own input |

### Linux lifecycle

```
pactl load-module module-null-sink \
  sink_name=shotlister_out \
  sink_properties=device.description="Shotlister Out"
```

- Idempotent: an existing sink named `shotlister_out` is reused, not duplicated.
- Only a module this process loaded is unloaded, on quit. A sink somebody made by hand survives.
- No `pactl` on PATH, or a load that fails, is reported as *unavailable* with the reason. It is
  never fatal and never retried in a loop.
- Created at app start when the Intercom output is enabled, or when the operator enables it.
  Never during a Live session.

### Detection

The renderer enumerates output devices and marks the ones known to be loopback devices, by
case-insensitive substring of the device label:

| Platform | Matched |
|---|---|
| Linux | `shotlister out` |
| macOS | `blackhole`, `loopback audio` |
| Windows | `cable input`, `vb-audio`, `voicemeeter` |

A match is offered as the Intercom output. The operator can still pick any output device by hand —
the setting stores a device id, not a name, so a device that vanishes is shown as *not connected*
exactly as the existing selectors already do.

When nothing matches, the panel says which to install:

| Platform | Guidance |
|---|---|
| macOS | BlackHole — `brew install blackhole-2ch`, or the installer from existential.audio |
| Windows | VB-CABLE from vb-audio.com |
| Linux | PipeWire or PulseAudio is required; `pactl` was not found |

The app never downloads or runs an installer.

## Routing

Two new settings, beside the existing per-sound selectors:

```ts
interface AudioDeviceSettings {
  cueSinkId: string | null
  announcementSinkId: string | null
  intercomEnabled: boolean        // new
  intercomSinkId: string | null   // new
}
```

With `intercomEnabled` and a sink chosen, every Cue and every Announcement plays **twice**: once
on the device its own setting names, once on the Intercom output.

- **Cues** — countdown numbers and beeps, from the operator window only. The Phone view shares the
  widget but never routes to an Intercom output: the setting belongs to the machine that has one.
- **Announcements** — prepared exactly as the primary copy is, ahead of the cue, so the intercom
  copy does not start a device stream at the moment the word is due.
- **Reference media** is not routed. Scrubbing a rehearsal video must not reach the band.

The copies start in the same task. The Announcement path delay applies to both, because it
describes the route out of this machine; the operator therefore hears the utterance earlier than
the band does, which is the same relationship they already have with the delay.

A failing Intercom output degrades to nothing: `setSinkId` rejecting, or a device that has gone,
is logged once and the primary copy plays regardless.

## UI

A section in **Voice & audio settings…**, below Output devices:

- A toggle: *Also send Cues and Announcements to an intercom*.
- The device selector, with detected loopback devices marked and the Linux-created sink labelled
  *created by Shotlister*.
- The Virtual output's status line: created / found / unavailable, with the guidance above when
  unavailable, and *record “Monitor of Shotlister Out” in your intercom client* when created.
- A *Test* button, which plays one beep on the Intercom output only, so the routing can be proved
  without starting a show.

## Acceptance criteria

- On Linux, enabling the Intercom output creates a sink whose monitor is selectable in Mumble, and
  quitting the app removes it.
- Enabling it twice, or restarting after a crash, never leaves two `shotlister_out` sinks.
- With it enabled, a Cue and an Announcement are each heard on both the operator's device and the
  Intercom output.
- With it disabled, or with no device chosen, playback is byte-for-byte the current behaviour.
- A missing or dead Intercom output never prevents the operator's own copy from playing.
- The Phone view never routes to an Intercom output.
- `yarn test` passes.
