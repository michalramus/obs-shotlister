# The Virtual output is created only where the OS allows it; elsewhere it is found

An Output that feeds a voice-chat client needs a loopback device: something the app can play
into and that client can record from. Where that device comes from is not the same question on
all three platforms, and the app does not pretend it is.

On **Linux** the app creates it. PipeWire and PulseAudio both accept
`pactl load-module module-null-sink sink_name=shotlister_out`, at runtime, from an unprivileged
process, and the sink's monitor appears immediately as a recordable source named *Monitor of
Shotlister Out*. This is the whole feature, done properly: no install, no third party, and the
device is gone again when the app quits.

On **macOS** and **Windows** the app cannot create it. A macOS loopback device is a Core Audio
server plug-in living in `/Library/Audio/Plug-Ins/HAL`, installed with administrator rights and
loaded by `coreaudiod`; a Windows one is a driver. Neither can be conjured by a renderer or a
Node process, and neither should be: installing an audio driver behind a toggle in a shotlist app
is not a thing a user can reasonably consent to mid-show.

So on those two platforms the app **detects and guides**. It looks for the devices people already
use for exactly this — BlackHole and Loopback on macOS, VB-CABLE and VoiceMeeter on Windows —
marks them in the device list an Output picks from, and when none is present says which one to
install and where from. It never downloads or runs an installer.

## Consequences

The feature is not uniform, and the settings panel says so rather than hiding it. On Linux the
operator sees *Shotlister Out — created by Shotlister*; on macOS and Windows they see either a
found device or a short install instruction. The device name `shotlister_out` and the description
*Shotlister Out* are therefore Linux-only strings; a mac or Windows operator routes to a device
named after whatever they installed, which is why the setting stores a device id and not a name.

A crashed run can leave the sink loaded. Creation is idempotent: an existing `shotlister_out` is
reused, and only a module this process loaded is unloaded on quit, so a sink somebody set up by
hand outlives the app.

Nothing here is on the Live session's critical path. Sink creation happens at start, or when the
operator asks for it from the settings panel, never while a show runs — and a failure to create
one leaves every other Output working, because Outputs are additive by construction (they
duplicate, never move). The worst case is that the voice-chat client is silent and the operator
still hears everything.

## Since ADR 0010

The Intercom output this decision was written for no longer exists as its own concept: a
loopback device is now simply what one of the two Outputs can be pointed at. Nothing above
changes — the platform differences, the creation on Linux, the detect-and-guide elsewhere, and
the idempotent create and selective unload are all as decided here. What moved is where the
operator meets it: the status line and the *Create Shotlister Out* button sit under whichever
Output currently names a loopback device, and the sink is created at start unconditionally
rather than behind a toggle, because no setting says "I want an intercom" any more.
