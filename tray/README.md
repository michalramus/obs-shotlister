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
shotlister-tray --host 192.168.1.20              # tray icon + settings window
shotlister-tray --headless --host 192.168.1.20   # no GUI, for a service unit
shotlister-tray --play-test                      # play every cue once and exit
shotlister-tray --help
```

Point it at the machine running the main app, on the port its server listens on — the same
one the Phone view uses, `3000` unless `PORT` was set on the main app.

### Command line

| Flag | Default | Description |
|---|---|---|
| `--host <HOST>` | — | Machine running the main app. Accepts `10.0.0.5`, `10.0.0.5:3000`, or a pasted `http://10.0.0.5:3000`; a port given here fills in `--port` |
| `--port <PORT>` | `3000` | Port the main app's server listens on |
| `--volume <LEVEL>` | `1.0` | Playback volume, `0.0` to `1.0`. Values outside the range are clamped |
| `--mute-count` | off | Start with the spoken countdown muted |
| `--mute-beep` | off | Start with the expiry beep muted |
| `--headless` | off | No window, no tray. Logs link and cue state to stdout and exits cleanly on `SIGTERM`. Requires a host |
| `--settings` | off | Open the settings window at startup, for desktops with no system tray |
| `--play-test` | off | Play every cue in order, then "one" and the beep together, and exit. Needs no network |
| `--config <PATH>` | platform path | Use this config file instead of the default location |
| `-v`, `--verbose` | off | Log the remaining time on every state change, not just the shot |
| `-h`, `--help` | — | Print help |

### Precedence

**Command line beats config file beats default.** Flags are one-shot overrides and never
rewrite the file, so a service unit started with `--volume 0.5` cannot silently overwrite
what somebody chose in the window.

`--mute-count` and `--mute-beep` only ever turn muting *on*. There is no `--unmute`: a bare
service invocation should not be able to un-silence a tray somebody muted deliberately.

A `--host` carrying its own port supplies both, unless an explicit `--port` overrides it:

```bash
shotlister-tray --host 10.0.0.5:4000              # port 4000
shotlister-tray --host 10.0.0.5:4000 --port 5000  # port 5000 wins
```

### Settings file

Written atomically and debounced, so a crash mid-write cannot leave a half-written file. A
corrupt or partial config falls back to defaults with a message rather than refusing to
start — the window is how you would fix it, so it has to open.

| OS | Path |
|---|---|
| Linux | `~/.config/shotlistertray/config.json` |
| macOS | `~/Library/Application Support/dev.shotlister.ShotlisterTray/config.json` |
| Windows | `%APPDATA%\shotlister\ShotlisterTray\config\config.json` |

```json
{
  "host": "192.168.1.20",
  "port": 3000,
  "volume": 1.0,
  "mute_count": false,
  "mute_beep": false
}
```

Every field is optional; anything missing takes its default.

### Running headless as a service

`--headless` skips the window and the tray entirely and is what a dedicated switching
machine wants. It logs one line per state change, so `journalctl -u shotlister-tray -f`
shows the link coming and going.

```ini
# ~/.config/systemd/user/shotlister-tray.service
[Unit]
Description=Shotlister Cue Tray
After=sound.target

[Service]
ExecStart=/usr/local/bin/shotlister-tray --headless --host 192.168.1.20
Restart=on-failure

[Install]
WantedBy=default.target
```

```bash
systemctl --user enable --now shotlister-tray
```

### When there is no sound

1. `shotlister-tray --play-test` — if this is silent the problem is the audio device, not
   the link. The settings window names the device it opened, which is usually enough on a
   machine full of capture hardware.
2. Check the status line. "Not connected" carries the real error, so a typo in the address
   reads differently from a firewall.
3. A muted countdown still beeps, and a muted beep still counts. If exactly one of the two
   is missing, check the mute toggles before anything else.

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
