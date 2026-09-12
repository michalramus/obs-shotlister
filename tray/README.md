# Shotlister Cue Tray

Runs on the video switching computer. It connects to the main app's socket.io server over
the LAN and plays the same audio cues the operator window plays — the spoken "three / two /
one" countdown and the beep at Shot expiry — so the switcher operator hears them without
having a shotlist open.

It is read-only. It never emits, and the main app needs no knowledge of it.

## Build

Needs a rustup toolchain. On macOS, Homebrew's separate `rust` formula puts a broken
`rustc` earlier on `PATH`, so `brew uninstall rust` if `rustc --version` fails.

```bash
cargo build --release      # target/release/shotlister-tray, ~6.5 MB, no runtime assets
cargo test                 # the cue engine and the wire fixtures
```

The cue sounds are decoded from `../resources/audio/*.opus` by `build.rs` and embedded, so
there is nothing to install alongside the binary. `ogg` and `opus` are build-dependencies
only — no libopus is linked into what ships.

If the vendored libopus build ever fails (most likely on Windows MSVC, which may want
`cmake` on `PATH`), decode the cues once with ffmpeg and `include_bytes!` the results
instead of running build.rs:

```bash
for f in one two three beep; do
  ffmpeg -i ../resources/audio/$f.opus -f s16le -ar 48000 -ac 1 assets/pcm/$f.pcm
done
```

## Run

```bash
shotlister-tray --host 192.168.1.20            # tray icon + settings window
shotlister-tray --headless --host 192.168.1.20 # no GUI, for a service unit
shotlister-tray --play-test                    # play every cue once and exit
shotlister-tray --help
```

Every setting the window offers is also a flag. Flags are one-shot overrides and never
rewrite the config file, so a service unit's arguments cannot silently undo what somebody
chose in the window. `--mute-count` and `--mute-beep` only ever mute.

Settings live in `config.json` under the platform's config directory:

| OS | Path |
|---|---|
| Linux | `~/.config/shotlistertray/config.json` |
| macOS | `~/Library/Application Support/dev.shotlister.ShotlisterTray/config.json` |
| Windows | `%APPDATA%\shotlister\ShotlisterTray\config\config.json` |

## Where the icon appears

| OS | Placement |
|---|---|
| Linux Mint (Cinnamon / MATE / Xfce) | Panel system tray, bottom-right. Works out of the box |
| GNOME | Needs the AppIndicator extension; without an SNI host the item never appears |
| macOS | Menu bar, top-right. No Dock icon |
| Windows | Notification area; may sit behind the `^` overflow until pinned |

Left click opens the settings window; right click gives Settings and Quit. Closing the
window hides it. If no tray host answers, the window stays on screen and closing it quits,
so the program can never become something you can neither see nor stop. `--settings` forces
the window open at startup.

The icon is a ring with a centre dot; the dot disappears when the link is down.

## Packaging

- **Linux**: the bare binary, plus `packaging/shotlister-tray.desktop` in
  `~/.local/share/applications`. Copy it to `~/.config/autostart` to start it with the
  session.
- **macOS**: `./scripts/bundle-mac.sh` builds a universal `Shotlister Cue Tray.app`. The
  bundle is required: without an `Info.plist` there is no `LSUIElement`, so macOS gives the
  program a Dock icon and treats it as a foreground app. It is ad-hoc signed, not notarised,
  so the first launch needs right-click → Open.
- **Windows**: the bare `.exe`. Release builds set `windows_subsystem = "windows"` so no
  console flashes; debug builds keep one for logs. SmartScreen will warn on an unsigned
  binary — "More info" → "Run anyway".

## How it works

```
main app  --socket.io-->  net thread  --Update-->  engine thread  --Cue-->  audio thread
                                                        |
                                                     status
                                                        v
                                            main thread: window + tray
```

The engine thread owns the Live session model outright and does nothing per 50 ms tick but
apply whatever arrived and ask a pure scheduler what to play, so neither a network stall nor
an audio-device stall can push a beep late.

`src/engine.rs` is a deliberate line-for-line port of the countdown in
`src/shared/components/ShotlistWidget.tsx`, down to its oddities — a number is spoken as its
second falls away, a late join does not fire retroactively, and a clock jump speaks once
rather than catching up. The operator window and the Cue Tray beeping at different moments
is the one failure this program must not have, so fidelity beats elegance and the tests in
that file pin every case.

Losing the link clears the anchor and stops cues. A stale countdown would beep against a
session that may have been stopped, skipped or advanced while the link was down — and a
silent tray is visibly broken, where a lying one is worse. The server replays its whole
state on connect, so reconnecting resyncs in one round trip.

## Testing against the main app

Run `yarn dev` in the repo root, note the machine's LAN address, then point the tray at it.
Start a Live session with a short Shot and listen to the operator window and the tray side
by side — any audible offset means the tick or the anchor is wrong.
