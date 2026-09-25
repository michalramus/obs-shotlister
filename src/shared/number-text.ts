/**
 * The text a countdown number is synthesised from.
 *
 * It is the digit. Piper phonemises through espeak-ng, which expands numerals
 * into the voice's own language — "3" becomes "trzy" for a Polish voice and
 * "three" for an English one — so one text serves every language and the app
 * carries no number vocabulary of its own.
 *
 * This module used to spell every number out in Polish and English, which meant
 * two hand-written tables, a compound-number assembler, and a guess at a voice's
 * language from the first two letters of its id. All of that existed to avoid
 * handing the engine a digit. The engine handles digits.
 *
 * One wrinkle, handled where clips are written rather than here: espeak pads a
 * bare numeral with a couple of hundred milliseconds of silence at the front,
 * where it pads a spelled word with none — and not the same amount each time.
 * Countdown numbers are scheduled on exact one-second marks, so uneven pads are
 * heard as uneven spacing: "3 2 1" limps despite a perfect schedule. See
 * `trimLeadingSilence` in main/speech/engine.
 *
 * Numbers 1..60 are rendered once per Voice unconditionally, which is why this
 * covers the whole range rather than just the default countdown set: changing
 * which numbers a countdown uses must never be able to require a re-render.
 */

/**
 * Every number a countdown may use, rendered in full for each Voice.
 *
 * Defined here rather than with the render planner that consumes it, because
 * this module has no Node dependencies and the planner does: the settings UI
 * needs these bounds to validate a countdown, and pulling them through the
 * planner dragged `node:crypto` into the renderer bundle.
 */
export const NUMBER_CLIP_MIN = 1
export const NUMBER_CLIP_MAX = 60
export const NUMBER_CLIP_RANGE = { first: NUMBER_CLIP_MIN, last: NUMBER_CLIP_MAX } as const

/** The text for `n`, or null when it is outside the rendered range. */
export function numberText(n: number): string | null {
  if (!Number.isInteger(n) || n < NUMBER_CLIP_MIN || n > NUMBER_CLIP_MAX) return null
  return String(n)
}

/** Every number clip a Voice needs: 1..60 mapped to the text it is spoken from. */
export function numberTexts(): Map<number, string> {
  const texts = new Map<number, string>()
  for (let n = NUMBER_CLIP_MIN; n <= NUMBER_CLIP_MAX; n++) {
    const text = numberText(n)
    if (text !== null) texts.set(n, text)
  }
  return texts
}
