import { describe, expect, it } from 'vitest'

import { DEFAULT_SETTINGS, effectiveRoute, mergeProviders, normalizeSettings, primarySupportsVision } from './settings'
import type { Settings } from './settings'

// Image attach honest-hint capability: which enabled primary can actually SEE
// an image. MIRRORS the engine's VISION_PROVIDERS (openai/claude/gemini); local
// + CLI bridges + custom endpoints are non-vision (the composer then says so).
describe('primarySupportsVision', () => {
  const withPrimary = (id: string): Settings => ({
    ...DEFAULT_SETTINGS,
    providers: DEFAULT_SETTINGS.providers.map((p) => ({
      ...p,
      enabled: p.id === id,
      primary: p.id === id,
    })),
  })

  it('is true for openai / claude / gemini', () => {
    for (const id of ['openai', 'claude', 'gemini']) {
      expect(primarySupportsVision(withPrimary(id))).toBe(true)
    }
  })

  it('is false for the local model (default primary)', () => {
    expect(primarySupportsVision(withPrimary('local'))).toBe(false)
  })

  it('is false for CLI-bridge primaries', () => {
    expect(primarySupportsVision(withPrimary('claude-cli'))).toBe(false)
    expect(primarySupportsVision(withPrimary('codex-cli'))).toBe(false)
  })

  it('is false when no primary is enabled', () => {
    const none: Settings = {
      ...DEFAULT_SETTINGS,
      providers: DEFAULT_SETTINGS.providers.map((p) => ({ ...p, enabled: false, primary: false })),
    }
    expect(primarySupportsVision(none)).toBe(false)
  })
})

// Stores written before "real model labels" (0d4475d) persisted the provider
// CARD label as the claude-cli model. Forwarded to the engine it becomes a
// literal `--model claude-code-subscription`, the CLI exits 1, and every chat
// falls back to the offline stub ("Couldn't reach the AI").
describe('mergeProviders CLI model migration', () => {
  const storedCli = {
    id: 'claude-cli',
    name: 'Claude Code (Pro/Max plan)',
    baseUrl: '',
    apiKey: '',
    enabled: true,
    primary: true,
    connected: true,
  }

  it('clears the legacy claude-cli display-label model', () => {
    const merged = mergeProviders([{ ...storedCli, model: 'claude-code-subscription' }])
    const cli = merged.find((p) => p.id === 'claude-cli')
    expect(cli?.model).toBe('')
    expect(cli?.enabled).toBe(true)
    expect(cli?.primary).toBe(true)
  })

  it('keeps a real user-picked claude-cli model override', () => {
    const merged = mergeProviders([{ ...storedCli, model: 'opus' }])
    expect(merged.find((p) => p.id === 'claude-cli')?.model).toBe('opus')
  })
})

describe('companion grant settings (2026-07-29 spec)', () => {
  it('defaults: writes granted, tools ask-first, blocking off, telegram off', () => {
    expect(DEFAULT_SETTINGS.projectWrites).toBe(true)
    expect(DEFAULT_SETTINGS.mcpApproval).toBe('ask')
    expect(DEFAULT_SETTINGS.approvalBlocking).toBe(false)
    expect(DEFAULT_SETTINGS.telegramReports).toBe(false)
    expect(DEFAULT_SETTINGS.telegramBotToken).toBe('')
    expect(DEFAULT_SETTINGS.telegramChatId).toBe('')
  })
})

// THE DEPENDENCY DIAL (Sukhdeep, 2026-08-29: "is there any drag button where
// we can increase the dependency on online AI or local AI?"). One slider,
// honest mechanics: it only sets the DEFAULT route hint — the same --route
// the engine already enforces per turn — and the privacy floor outranks it
// always. A per-message choice outranks the dial; 'auto' keeps today's
// behavior byte-identical.
describe('routeBias — the local↔online dependency dial', () => {
  it('sanitize keeps only the three positions and defaults to auto', () => {
    expect(normalizeSettings({ routeBias: 'local' } as never).routeBias).toBe('local')
    expect(normalizeSettings({ routeBias: 'cloud' } as never).routeBias).toBe('cloud')
    expect(normalizeSettings({ routeBias: 'nonsense' } as never).routeBias).toBe('auto')
    expect(normalizeSettings({} as never).routeBias).toBe('auto')
  })

  it('effectiveRoute: the dial fills only an absent/auto per-message hint', () => {
    expect(effectiveRoute('local', undefined)).toBe('local')
    expect(effectiveRoute('local', 'auto')).toBe('local')
    expect(effectiveRoute('cloud', undefined)).toBe('cloud')
    expect(effectiveRoute('auto', undefined)).toBe(undefined)
    // The person's explicit choice on one message always wins.
    expect(effectiveRoute('local', 'cloud')).toBe('cloud')
    expect(effectiveRoute('cloud', 'local')).toBe('local')
  })
})
