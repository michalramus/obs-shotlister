# The outgoing Shot stays visible through the incoming Shot's Transition

When the operator hits Next and the incoming Shot has a Transition, the Shot leaving air
keeps its row in the shotlist until the Transition finishes. It is hidden when the main
process says so, not when the live position changes. A Shot taken with a cut still
disappears immediately.

During a Transition both Shots are genuinely on screen in OBS, so hiding the outgoing one
the instant the Transition starts makes the shotlist disagree with the picture — for the
camera operator whose Shot it is, their row vanishes while they are still live.

The two surfaces used to disagree: the Phone view held the outgoing Shot, the operator
window dropped it immediately. Neither was designed; each store had grown its own rule.
Both now derive the shotlist from `src/shared/live-view.ts`, and this is the rule they
share.

## Consequences

The shotlist can briefly show one more visible Shot than the Live queue considers
un-hidden, and that is correct rather than a lag to be fixed. Anything deriving "what is
on air" from the shotlist must account for two Shots being visible mid-Transition.
