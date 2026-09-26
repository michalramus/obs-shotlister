/**
 * Which devices one sound is played on.
 *
 * The Intercom output duplicates rather than moves: a Cue or an Announcement is
 * played again on the loopback device an intercom client records, while the
 * operator keeps hearing it on their own. That makes "the device for this sound"
 * a list everywhere audio is played, and this is the one place that decides what
 * is in it.
 */

/**
 * The devices to play a sound on, primary first. `null` is the system default.
 *
 * @param primary The device this sound's own setting names.
 * @param intercom The Intercom output, or `null` when it is off or unchosen.
 */
export function outputTargets(
  primary: string | null,
  intercom: string | null,
): readonly (string | null)[] {
  // The same device twice is two elements playing the same clip into one output:
  // audibly a stutter, not a duplicate. It happens the moment somebody points
  // the Announcement selector at the Virtual output and then switches the
  // Intercom output on as well, which is a reasonable thing to try.
  if (intercom === null || intercom === primary) return [primary]
  return [primary, intercom]
}
