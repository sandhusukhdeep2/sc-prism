import { describe, expect, it } from 'vitest'
import { modelColor, modelKey } from './modelColor'

describe('modelKey', () => {
  it('normalizes a "provider · model" label to the provider key', () => {
    expect(modelKey('claude-cli · claude-code-subscription')).toBe('claude')
    expect(modelKey('local · local-model')).toBe('local')
    expect(modelKey('gemini · gemini-2.0-flash')).toBe('gemini')
  })

  it('normalizes a bare provider the same way', () => {
    expect(modelKey('claude-cli')).toBe('claude')
    expect(modelKey('local')).toBe('local')
    expect(modelKey('gemini')).toBe('gemini')
    expect(modelKey('openai')).toBe('openai')
  })

  it('is case-insensitive', () => {
    expect(modelKey('Claude-CLI · Claude Code')).toBe('claude')
  })

  it('falls back to the normalized provider itself for an unknown provider', () => {
    expect(modelKey('mistral · mistral-large')).toBe('mistral')
  })
})

describe('modelColor', () => {
  it('maps known providers to their fixed colors', () => {
    const local = modelColor('local')
    const gemini = modelColor('gemini')
    const claude = modelColor('claude')
    const openai = modelColor('openai')
    // fixed, distinct, and stable across calls
    expect(modelColor('local')).toBe(local)
    expect(modelColor('gemini')).toBe(gemini)
    expect(modelColor('claude')).toBe(claude)
    expect(modelColor('openai')).toBe(openai)
    const set = new Set([local, gemini, claude, openai])
    expect(set.size).toBe(4)
  })

  it('resolves a "provider · model" label to the provider color', () => {
    expect(modelColor('claude-cli · claude-code-subscription')).toBe(modelColor('claude'))
    expect(modelColor('local · local-model')).toBe(modelColor('local'))
    expect(modelColor('gemini · gemini-2.0-flash')).toBe(modelColor('gemini'))
  })

  it('gives two different unknown providers two different stable colors', () => {
    const mistral = modelColor('mistral · mistral-large')
    const cohere = modelColor('cohere · command-r')
    expect(mistral).not.toBe(cohere)
    // stable — same key twice gives the same color
    expect(modelColor('mistral · mistral-large')).toBe(mistral)
    expect(modelColor('cohere · command-r')).toBe(cohere)
  })

  it('never collides an unknown provider with a known one', () => {
    const unknown = modelColor('mistral')
    expect(unknown).not.toBe(modelColor('local'))
    expect(unknown).not.toBe(modelColor('gemini'))
    expect(unknown).not.toBe(modelColor('claude'))
    expect(unknown).not.toBe(modelColor('openai'))
  })
})
