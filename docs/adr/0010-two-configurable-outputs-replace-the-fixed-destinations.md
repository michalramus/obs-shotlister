# Two configurable Outputs replace the fixed destinations, and a delay plays a sound earlier

The app used to have three destinations, each hard-wired to a kind of sound: a device for the
operator's Cues, a device for Announcements, and an Intercom output that took a copy of both.
Beside them sat one path delay, stored with the Voice settings, which shifted Announcements
earlier because Mumble buffers.

Every real request we got was a combination that model could not express. The band needs the
countdown *beep* on their route as much as the part name, and the Announcement device carried
only speech. The operator's own speakers need no compensation while the band's route needs
400ms of it, and the delay was global — one number describing Mumble, applied to a copy that
never went near it. An operator with one pair of speakers and nothing else wanted one device
carrying everything, and had to set the same device three times.

So the names were the problem, not the count. An Output is now **a device, a delay, and what
it carries** (Announcements, Cues, or both), and the app has two of them. Output 1 is the
operator's own, positionally and always enabled: it is the copy their mute button silences and
the only one that falls back to the system default when its device disappears. Output 2 has a
switch, and is the second listener — usually a Virtual output a voice-chat client sends on to
the band.

Two rather than a list. Two is what the routes physically are: the ears in the room, and the
thing that carries the show onward. A list would need add and remove controls, a name per
entry, and an answer to "which one is mine" that the pair gives away for free.

**A delay plays a sound earlier, not later.** It is how long that Output's route takes to
reach its listener, so everything the Output carries is played that much *before* the moment
it is wanted, and lands on the beat once the route has buffered it. Negative plays later, for
a route that somehow runs ahead. The alternative reading — a delay as something the app adds —
is the one an operator can arrive at unaided, which is why the settings field spells out the
direction in words rather than only in a number.

## Consequences

The same sound is now a different moment per Output, and both triggers had to learn that. A
Cue fires once per distinct delay among the Outputs that carry Cues, so the copy for a route
that buffers 400ms is played 400ms before the copy on the operator's speakers
(`src/shared/audio/cue-schedule.ts`).

An Announcement is **planned once per distinct delay** — one `AnnouncementRoute` each — rather
than scheduled once and its copies offset afterwards. Offsetting looks equivalent and is not:
the arithmetic that drops a countdown number with no room left runs against whichever delay it
was scheduled for, so one plan built at the worst delay would silently take that number away
from every listener, including the ones who had time for it. Planning per delay costs one
extra pass over five durations and keeps each listener the numbers their own route fits.

Edit mode badges a Call that will not announce against the **worst** delay among the enabled
voice-carrying Outputs. A badge is a warning, so it is pessimistic on purpose: it may mark a
Call that Output 1 would in fact speak in full, which is the harmless direction to be wrong in.

The Intercom output is gone as a concept. A loopback device is simply what an Output can be
pointed at, so ADR 0008's detect-and-guide behaviour attaches to whichever Output currently
names one, and the Virtual output is created at start unconditionally — there is no longer a
setting whose switching on means "make me one".

Stored settings migrate **by intent rather than by count**, because three destinations do not
fit two Outputs: Output 1 keeps the Cue device at no delay, Output 2 takes the Announcement
device and the old path delay, and Output 2 is switched on only when the old settings actually
asked for a second destination. An operator who used an Intercom output re-points an Output at
their loopback device, and the migration says so in the log, because nothing else would.

Two Outputs on one device are deduplicated only when their delays match too. The identical
pair is a stutter — one clip in one device through two elements, which sounds like a fault.
The same device at two delays is not that; it is two wanted moments, which is exactly what an
operator asks for when one Output feeds their speakers now and the other feeds the same cable
early.

The Phone view and the Cue Tray are untouched. A handset has one output and no business naming
another, so its player is handed the type without the method that would point it somewhere
(`PhoneCuePlayer`), and the Cue Tray plays on the switching machine's own device as it always
did.
