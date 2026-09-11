# The main process is the single source of truth for the phone view

Phones receive fully-resolved state pushed over socket.io from the embedded server in the
Electron main process: the Rundown, its Shots with hidden flags already applied, the
Cameras, and the live position. They never query the database and never derive what is live
from a local copy of the Rundown.

The alternative was syncing the Rundown to each phone once and letting it compute the live
position from a clock. We rejected it because phones join and leave mid-show on an unstable
LAN, and a camera operator acting on a locally-derived position that has drifted from the
operator's is a wrong camera on air. Pushing resolved state makes a disconnected phone
visibly stale rather than confidently wrong.

## Consequences

Every state change in the main process must reach the phones, which makes the fan-out a
correctness concern rather than a convenience. Payloads are larger than a delta protocol
would be; this is deliberate, and fine for the shot counts and LAN this runs on.
