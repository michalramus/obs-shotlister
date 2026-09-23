import { describe, it, expect } from 'vitest'
import {
  numberWord,
  numberWords,
  languageOfVoice,
  NUMBER_CLIP_MIN,
  NUMBER_CLIP_MAX,
} from './number-words'

describe('numberWord', () => {
  it('spells Polish units, teens and tens', () => {
    expect(numberWord(1, 'pl')).toBe('jeden')
    expect(numberWord(5, 'pl')).toBe('pięć')
    expect(numberWord(10, 'pl')).toBe('dziesięć')
    expect(numberWord(15, 'pl')).toBe('piętnaście')
    expect(numberWord(20, 'pl')).toBe('dwadzieścia')
    expect(numberWord(60, 'pl')).toBe('sześćdziesiąt')
  })

  it('spells Polish compounds as two words', () => {
    expect(numberWord(21, 'pl')).toBe('dwadzieścia jeden')
    expect(numberWord(47, 'pl')).toBe('czterdzieści siedem')
  })

  it('spells English units, teens and tens', () => {
    expect(numberWord(3, 'en')).toBe('three')
    expect(numberWord(13, 'en')).toBe('thirteen')
    expect(numberWord(40, 'en')).toBe('forty')
  })

  it('spells English compounds without a hyphen', () => {
    expect(numberWord(21, 'en')).toBe('twenty one')
    expect(numberWord(59, 'en')).toBe('fifty nine')
  })

  it('returns null outside the rendered range', () => {
    expect(numberWord(0, 'pl')).toBeNull()
    expect(numberWord(61, 'pl')).toBeNull()
    expect(numberWord(-1, 'en')).toBeNull()
    expect(numberWord(2.5, 'en')).toBeNull()
  })
})

describe('numberWords', () => {
  it('covers every number in the rendered range', () => {
    for (const language of ['pl', 'en'] as const) {
      const words = numberWords(language)
      expect(words.size).toBe(NUMBER_CLIP_MAX - NUMBER_CLIP_MIN + 1)
      for (let n = NUMBER_CLIP_MIN; n <= NUMBER_CLIP_MAX; n++) {
        expect(words.get(n)).toBeTruthy()
      }
    }
  })

  it('gives every number a distinct word', () => {
    const words = [...numberWords('pl').values()]
    expect(new Set(words).size).toBe(words.length)
  })
})

describe('languageOfVoice', () => {
  it('reads the language from a Piper voice id', () => {
    expect(languageOfVoice('pl_PL-gosia-medium')).toBe('pl')
    expect(languageOfVoice('en_US-amy-medium')).toBe('en')
    expect(languageOfVoice('en_GB-alan-low')).toBe('en')
  })

  it('falls back to English rather than failing on an unknown id', () => {
    expect(languageOfVoice('')).toBe('en')
    expect(languageOfVoice('whatever')).toBe('en')
  })
})
