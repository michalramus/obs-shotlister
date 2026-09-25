/**
 * How an Announcement problem is shown on the timeline.
 *
 * Shared because both the item lane and its summary strip say the same thing
 * about the same condition, and a warning that disagreed with itself between the
 * block and the strip would be worse than no warning.
 */

import type { AnnouncementProblem } from '../../timeline/lyrics'

/**
 * `phrase-only` is the one worth spelling out: it is not a failure the show will
 * make obvious. The name is spoken, the Announcement sounds like it worked, and
 * the band simply never hears a count.
 */
export const ANNOUNCEMENT_PROBLEM_TITLE: Record<AnnouncementProblem, string> = {
  dropped: 'too short for its announcement; nothing will be spoken',
  'phrase-only': 'too short for a countdown; only the name will be spoken, with no numbers',
}

/**
 * Red for silence, amber for a name with no count.
 *
 * Both are loud on purpose. These warnings mark Calls that are *short*, which
 * are the narrowest blocks on the timeline — the place a subtle mark is least
 * likely to be seen, and the mark most worth seeing.
 */
export const ANNOUNCEMENT_PROBLEM_COLOR: Record<AnnouncementProblem, string> = {
  dropped: '#e74c3c',
  'phrase-only': '#f1c40f',
}
