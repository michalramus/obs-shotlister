/**
 * How tall the assignment strip is — the row of buttons under the timeline that
 * assigns a Camera (Camera Rundown) or a Part (Voice-over Rundown) at the
 * Playhead.
 *
 * The strip used to be a hard 48px, and that number was also summed into the
 * timeline's fixed total height. Camera buttons never wrap — they are nowrap and
 * scroll sideways — so one line was always the truth for them. Parts do wrap, so
 * a Project with enough Parts put two lines of buttons inside a box sized for
 * one: the operator saw a strip too thick to be one line and too short to show
 * both, which is the defect this module exists to fix.
 *
 * The rule the operator chose: grow from one line to two when the buttons need
 * it, stop at two, and scroll beyond that. Which means the height is no longer a
 * constant the total can hardcode — it is derived here, from a measurement, and
 * the component uses the single value this returns for both the strip's own
 * `height` and the timeline's total. There is deliberately no second expression
 * that could drift from the first.
 *
 * Why a measurement at all: a button's height is its font's line box plus padding
 * and border, which no constant can honestly predict across platforms, and the
 * number of lines depends on how wide the Part names are. So the component reads
 * two numbers in its ResizeObserver callback — the content box's natural height
 * and one button's height — and every decision made from them is here, pure and
 * testable. Nothing in this module is reachable from the per-frame Playhead path
 * (see `src/renderer/timeline/playhead.ts`): measuring happens when the strip
 * resizes, never per frame.
 */

/** Padding above and below the buttons, in px. Matches the strip's CSS. */
export const ASSIGNMENT_STRIP_PADDING_Y = 6
/** The strip's top border, in px. Counted because the box is `border-box`. */
export const ASSIGNMENT_STRIP_BORDER_PX = 1
/** Gap between wrapped lines of buttons, in px. Matches the buttons' `gap`. */
export const ASSIGNMENT_STRIP_ROW_GAP = 6
/** Beyond this many lines the strip stops growing and scrolls instead. */
export const ASSIGNMENT_STRIP_MAX_LINES = 2
/**
 * The one-line height, unchanged from the constant this replaced. A single line
 * of buttons is shorter than this, and looked right in a 48px strip, so 48 is a
 * floor rather than an outcome of the arithmetic.
 */
export const ASSIGNMENT_STRIP_MIN_HEIGHT = 48

/** What the component reads off the DOM; zeroes before the first measurement. */
export interface AssignmentStripMeasure {
  /**
   * Natural height of the strip's content box in px — the full wrapped height,
   * even when the strip is clamped and scrolling.
   */
  contentHeightPx: number
  /** Height of one button in px. They are uniform, so any one of them will do. */
  buttonHeightPx: number
}

export interface AssignmentStripLayout {
  /** Lines the buttons actually occupy; at least 1. */
  lines: number
  /** Lines the strip shows: `lines`, capped at `ASSIGNMENT_STRIP_MAX_LINES`. */
  linesShown: number
  /** The strip's outer height in px, padding and border included. */
  heightPx: number
  /** True when the buttons do not fit, so the strip scrolls vertically. */
  scrolls: boolean
}

/**
 * Lines → height, capped at two.
 *
 * An unmeasured strip (jsdom, or a first paint before the observer runs) reports
 * one line at the minimum height, which is exactly what the strip was before.
 */
export function assignmentStripLayout(measure: AssignmentStripMeasure): AssignmentStripLayout {
  const buttonHeightPx = Math.max(0, measure.buttonHeightPx)
  const contentHeightPx = Math.max(0, measure.contentHeightPx)

  // Each line costs one button plus a gap, so add a gap to both sides of the
  // division and the fenceposts cancel. Rounding rather than ceiling: a content
  // box a fraction of a pixel over two lines is still two lines.
  const lines =
    buttonHeightPx > 0
      ? Math.max(
          1,
          Math.round(
            (contentHeightPx + ASSIGNMENT_STRIP_ROW_GAP) /
              (buttonHeightPx + ASSIGNMENT_STRIP_ROW_GAP),
          ),
        )
      : 1
  const linesShown = Math.min(lines, ASSIGNMENT_STRIP_MAX_LINES)

  const contentPx = linesShown * buttonHeightPx + (linesShown - 1) * ASSIGNMENT_STRIP_ROW_GAP
  const heightPx = Math.max(
    ASSIGNMENT_STRIP_MIN_HEIGHT,
    Math.ceil(contentPx) + 2 * ASSIGNMENT_STRIP_PADDING_Y + ASSIGNMENT_STRIP_BORDER_PX,
  )

  return { lines, linesShown, heightPx, scrolls: lines > linesShown }
}
