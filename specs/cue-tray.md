# Cue Tray

## What it is

A standalone program on the video switching computer that plays a Live session's audio cues.
The switcher operator sits at a different machine from the shotlist and otherwise hears
nothing; this gives them the countdown without giving them a shotlist to watch.

It is a pure consumer of the phone protocol. The main app is unchanged and unaware of it.

Source lives in `tray/`, built with cargo, outside the yarn build.

## Behaviour

- Connects to the main app's socket.io server, by address and port, over the LAN.
- Plays the cues the **operator window** plays in unfiltered mode: `three`, `two`, `one` at
  the end of each of the last three seconds of a Shot, and `beep.opus` at expiry.
- Does **not** reproduce the Phone view's camera-filter cues, so `beep-low.opus` is unused.
  There is no camera selection: the tray has no operator of its own to filter for.
- A tray icon whose glyph loses its centre dot when the link is down. Clicking it opens one
  window: volume, address, port, mute countdown, mute beep, connection status, the Live
  position, the output device name, and a Test sound button.
- A `--headless` mode with no GUI, for running as a service on a dedicated machine.

## Rules it inherits

- **Timers are advisory** (ADR 0002). Zero is a normal state that can last minutes; the beep
  fires once per Shot and the countdown runs on into overrun without triggering anything.
- **The main process is the source of truth** (ADR 0003). The tray holds no state the server
  did not send, and the connect handshake replays everything.
- **Live mode is not persisted** (ADR 0001). The tray writes only its own settings; it has
  no database and no opinion about the Rundown.
- Hidden Shots immediately after the live one extend the countdown, because the operator
  never cuts to them. Skipped Shots are hidden and sit after the live index, so this is
  routine rather than theoretical.

## Deliberate omissions

- No camera filter, and so no per-camera on-air/off-air cues.
- No shotlist. Anyone who needs to see one has the Phone view.
- The tray menu is Settings and Quit only. Every setting lives in the window, because a
  checkable "Mute beep" in the menu would have to be kept in step with the window, and one
  showing the wrong state during a show is worse than an extra click.
- No authentication, matching the server, which has none.
