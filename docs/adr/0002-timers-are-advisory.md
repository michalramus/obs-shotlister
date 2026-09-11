# Timers are advisory; the operator drives every switch

Shot durations drive countdowns and progress bars, but nothing in the system ever switches
a camera on its own. Every Next and Skip is an explicit operator action, whether from the
keyboard, the UI or OSC.

The obvious alternative — auto-advance when a Shot's time expires — was rejected because a
rundown is a plan, not a schedule. Live segments overrun constantly, and a system that cuts
away from a speaker mid-sentence because a timer expired is worse than no timer at all. A
countdown that reaches zero therefore keeps counting into overrun rather than triggering
anything.

## Consequences

Remaining time can legitimately be zero or negative for a long time, and UI must treat
"expired" as a normal state, not an error. Nothing in the codebase should acquire a
scheduler or an auto-advance timer without revisiting this decision.
