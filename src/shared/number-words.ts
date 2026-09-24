/**
 * The spoken form of a countdown number, per language.
 *
 * Announcements are pre-rendered (ADR 0005), so a number reaches the band as a
 * clip synthesised from a word rather than from a digit. Piper reads "10" out
 * loud differently depending on the voice, and in Polish not at all reliably, so
 * the word is spelled out here and the digit never reaches the engine.
 *
 * Numbers 1..60 are rendered once per Voice unconditionally, which is why this
 * covers the whole range rather than just the default countdown set: changing
 * which numbers a countdown uses must never be able to require a re-render.
 */

/**
 * Every number a countdown may use, rendered in full for each Voice.
 *
 * Defined beside the words rather than with the render planner that consumes
 * it, because this module has no Node dependencies and the planner does: the
 * settings UI needs these bounds to validate a countdown, and pulling them
 * through the planner dragged `node:crypto` into the renderer bundle.
 */
export const NUMBER_CLIP_MIN = 1
export const NUMBER_CLIP_MAX = 60
export const NUMBER_CLIP_RANGE = { first: NUMBER_CLIP_MIN, last: NUMBER_CLIP_MAX } as const

/** Languages a Voice can be announced in. Falls back to English. */
export type NumberLanguage = 'pl' | 'en'

const PL_ONES = [
  '',
  'jeden',
  'dwa',
  'trzy',
  'cztery',
  'pięć',
  'sześć',
  'siedem',
  'osiem',
  'dziewięć',
]

const PL_TEENS = [
  'dziesięć',
  'jedenaście',
  'dwanaście',
  'trzynaście',
  'czternaście',
  'piętnaście',
  'szesnaście',
  'siedemnaście',
  'osiemnaście',
  'dziewiętnaście',
]

const PL_TENS: Record<number, string> = {
  20: 'dwadzieścia',
  30: 'trzydzieści',
  40: 'czterdzieści',
  50: 'pięćdziesiąt',
  60: 'sześćdziesiąt',
}

const EN_ONES = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine']

const EN_TEENS = [
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
]

const EN_TENS: Record<number, string> = {
  20: 'twenty',
  30: 'thirty',
  40: 'forty',
  50: 'fifty',
  60: 'sixty',
}

function spell(
  n: number,
  ones: string[],
  teens: string[],
  tens: Record<number, string>,
): string | null {
  if (!Number.isInteger(n) || n < NUMBER_CLIP_MIN || n > NUMBER_CLIP_MAX) return null
  if (n < 10) return ones[n]
  if (n < 20) return teens[n - 10]

  const ten = Math.floor(n / 10) * 10
  const unit = n % 10
  const tensWord = tens[ten]
  if (!tensWord) return null
  // Compounds are two separate words even in English, where the written form
  // hyphenates: a hyphen is a rendering hint the engine does not need.
  return unit === 0 ? tensWord : `${tensWord} ${ones[unit]}`
}

/** The spoken form of `n`, or null when it is outside the rendered range. */
export function numberWord(n: number, language: NumberLanguage): string | null {
  return language === 'pl'
    ? spell(n, PL_ONES, PL_TEENS, PL_TENS)
    : spell(n, EN_ONES, EN_TEENS, EN_TENS)
}

/** Every number clip a Voice needs: 1..60 mapped to its spoken word. */
export function numberWords(language: NumberLanguage): Map<number, string> {
  const words = new Map<number, string>()
  for (let n = NUMBER_CLIP_MIN; n <= NUMBER_CLIP_MAX; n++) {
    const word = numberWord(n, language)
    if (word) words.set(n, word)
  }
  return words
}

/**
 * The language a Piper voice speaks, read from its id.
 *
 * Piper names voices `<lang>_<REGION>-<name>-<quality>`, e.g. `pl_PL-gosia-medium`.
 * An unrecognised id announces in English rather than failing, because a wrong
 * countdown language is a cosmetic problem and a missing countdown is not.
 */
export function languageOfVoice(voice: string): NumberLanguage {
  return voice.slice(0, 2).toLowerCase() === 'pl' ? 'pl' : 'en'
}
