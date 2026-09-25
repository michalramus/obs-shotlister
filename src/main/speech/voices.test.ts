import { describe, it, expect } from 'vitest'
import { voiceRepoPath } from './voices'

describe('voiceRepoPath', () => {
  it('nests a voice the way the catalogue does', () => {
    expect(voiceRepoPath('pl_PL-bass-high')).toBe('pl/pl_PL/bass/high')
    expect(voiceRepoPath('en_US-amy-medium')).toBe('en/en_US/amy/medium')
  })

  it('keeps an underscore in the name rather than splitting on it', () => {
    // Splitting the id on every separator would make this `mc/speech`.
    expect(voiceRepoPath('pl_PL-mc_speech-medium')).toBe('pl/pl_PL/mc_speech/medium')
    expect(voiceRepoPath('pl_PL-mls_6892-low')).toBe('pl/pl_PL/mls_6892/low')
  })

  it('handles a three-letter language code', () => {
    expect(voiceRepoPath('ckb_IQ-someone-medium')).toBe('ckb/ckb_IQ/someone/medium')
  })

  it('takes the name from between the first and last dash', () => {
    expect(voiceRepoPath('en_GB-alan-jones-low')).toBe('en/en_GB/alan-jones/low')
  })

  it('rejects anything that is not a voice id', () => {
    for (const bad of ['', 'gosia', 'pl_PL', 'pl_PL-', '-bass-high', 'pl_PL-bass-']) {
      expect(voiceRepoPath(bad)).toBeNull()
    }
  })

  it('rejects a language that is not a language code', () => {
    expect(voiceRepoPath('PL_PL-bass-high')).toBeNull()
    expect(voiceRepoPath('polish_PL-bass-high')).toBeNull()
  })
})
