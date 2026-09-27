# Feature: Outputs

## Dependencies

- `specs/voice-over-rundowns.md` — Announcement playback, which these route
- `specs/shotlist-widget.md` — which Cue fires when; this is where each copy of it goes
- ADR 0008 — why the Virtual output is created on Linux and only found elsewhere
- ADR 0010 — why two configurable Outputs replaced the fixed cue/announcement/intercom
  destinations, and why a delay plays a sound *earlier*

## Goal

Get every sound the show produces to every listener that needs it, on the device that reaches
them and at the moment they need to hear it — the operator at the desk, and whoever a voice-chat
client on this machine carries the show to.

The app has exactly **two Outputs**, positionally. Each one says three things:

| | Meaning |
|---|---|
| **device** | Where it plays. `null` is the system default. |
| **delay** | How long this route takes to reach its listener, in ms. |
| **carries** | `voice` (Announcements), `cues` (countdown and beeps), or `both`. |

**Output 1** is the operator's own. It is always enabled, it is the copy their mute buttons
silence, and it is the only one that falls back to the system default when its device
disappears. **Output 2** has an enable switch, and is the second listener.

Outputs **duplicate**; one never moves sound away from another.

```ts
interface AudioOutput {
  enabled: boolean // Output 1 is always true
  sinkId: string | null
  delayMs: number
  carries: 'voice' | 'cues' | 'both'
}

interface AudioDeviceSettings {
  outputs: [AudioOutput, AudioOutput]
}
```

Stored per Output under `audio_output1_*` / `audio_output2_*`. Settings from before the two
Outputs migrate by intent, once, at app start — see `migrateAudioDevices`.

## Delay

A delay is **how long the route costs**, so the sound is played that much **earlier** and is
*heard* on the beat. It applies to everything the Output carries: the band's countdown beep has
to land on the beat as much as the spoken part name does. Negative plays later, for a route that
somehow runs ahead. Bounded to ±5000ms, beyond which a delay would only mute the sounds it was
meant to move.

Because the same sound is a different moment on each Output, both triggers work per delay:

- **Cues** — one Cue crosses one moment per distinct delay among the Outputs carrying Cues
  (`cuesDueAt`), and the player plays only the copies with that delay. A delay longer than the
  time the Cue ever had simply drops that copy; the beep is clamped at expiry rather than lost,
  because a missing beep reads as a fault.
- **Announcements** — planned once per distinct delay, one `AnnouncementRoute` each, rather than
  scheduled once and offset. The arithmetic that drops a number with no room runs against the
  delay it was scheduled for, so one plan at the worst delay would take that number from
  everybody (ADR 0010).
- **Reference media** is never routed. Scrubbing a rehearsal video must not reach the band.
- **Mute is local.** Mute countdown and Mute beep silence Output 1's copy only — the operator's
  mute button is about their ears, exactly as it is for the Cue Tray, which the app's mute has
  never silenced either.

Edit mode badges a Call that will not announce against the **worst** delay among the enabled
voice-carrying Outputs: a badge is a warning, so it is pessimistic on purpose.

## Routing

`src/shared/audio/outputs.ts` answers every routing question once, for both processes:
`soundDestinations` (which copies exist, Output 1's first), `soundDelaysMs` (the distinct
moments), `worstCaseDelayMs` (what Edit mode badges against). `src/shared/audio/routed-clip.ts`
owns getting one sound onto them.

- A copy exists only for an **enabled** Output that **carries** the kind. An Output carrying
  neither kind a listener needs is silence: a setting, not a fault.
- Two Outputs on one device are deduplicated only when their **delays match too**. The identical
  pair is a stutter; the same device at two delays is two wanted moments.
- Devices are opened **ahead** of the sound, never at it: `setSinkId` is async and a beep is
  200ms. Cues are pooled and pre-routed; an Announcement clip is fetched, decoded and routed
  before its moment.
- A copy that misses its device goes **silent** rather than falling back — except Output 1's,
  which falls back to the default device. A copy meant for the band leaking into the operator's
  ear is every sound twice in the ear that has to hear the countdown.
- Failures are logged once and never fail the caller. A show keeps running when a device does not.
- The **Phone view** has one output and no way to name another: `PhoneCuePlayer` is the player
  type without `setOutputs`. The **Cue Tray** plays on the switching machine's own device and is
  unaware of any of this.

## The Virtual output

A loopback device an Output can be pointed at. The app's own is named **Shotlister Out**; where it
comes from depends on the platform (ADR 0008).

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
- Created at app start, unconditionally — no setting says "I want an intercom" any more — and on
  demand from the settings panel's button. Never during a Live session.

### Detection

The renderer enumerates output devices and marks the ones known to be loopback devices, by
case-insensitive substring of the device label:

| Platform | Matched |
|---|---|
| Linux | `shotlister out` |
| macOS | `blackhole`, `loopback audio` |
| Windows | `cable input`, `vb-audio`, `voicemeeter` |

A marked device is offered to either Output as *Use the loopback device*. The mark is a hint, not
a gate: any device stays selectable on any Output, because a cable somebody named themselves is
still a valid route. The setting stores a device id, not a name, so a device that vanishes shows
as *not connected*.

When nothing matches, the panel says which to install:

| Platform | Guidance |
|---|---|
| macOS | BlackHole — `brew install blackhole-2ch`, or the installer from existential.audio |
| Windows | VB-CABLE from vb-audio.com |
| Linux | PipeWire or PulseAudio is required; `pactl` was not found |

The app never downloads or runs an installer.

## UI

An **Outputs** section in **Voice & audio settings…**, with one block per Output:

- Output 1 is titled *Output 1 — your own* and has no switch. Output 2 leads with its enable
  toggle, and its controls read as inert while it is off rather than disappearing — an operator
  who switched it off last week should still see what it was pointed at.
- A device selector, with detected loopback devices marked *— loopback*.
- A delay field, draft-and-commit, rejecting rather than repairing what it cannot read, with a
  hint that says in words which direction the delay moves the sound.
- A *Carries* selector labelled by the sound, not the stored word: *Both* / *Announcements* /
  *Countdown and beeps*.
- A *Test* button, which plays one beep on that Output only, so a route can be proved without
  starting a show.
- The **Virtual output's** status line — created / found / unavailable, with the guidance above,
  and *record “Monitor of Shotlister Out” in your intercom client* when it exists — shown under
  whichever Output names a loopback device, and under Output 2 when neither does.
- *Device names are hidden until microphone permission is granted*, with a button to grant it:
  Chromium withholds output labels until then.

## Acceptance criteria

- On Linux the sink exists after app start and is gone after quit; starting twice, or after a
  crash, never leaves two `shotlister_out` sinks.
- With both Outputs enabled on different devices, a Cue and an Announcement are each heard on
  both.
- An Output carrying `cues` speaks no Announcement; an Output carrying `voice` plays no beep.
- With Output 2's delay set, its copy of each Cue and of the whole Announcement is played that
  much earlier than Output 1's.
- An Announcement whose first number does not fit Output 2's delay still plays that number on
  Output 1.
- A missing or dead Output 2 never prevents Output 1's copy from playing, and never lands in
  Output 1's device.
- Muting the countdown or the beep silences Output 1's copy only.
- The Phone view cannot name an Output.
- No database write happens during a Live session.
- `yarn test` passes.
