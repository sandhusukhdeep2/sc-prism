import { beforeEach, describe, expect, it, vi } from 'vitest'

const sendTelegramMock = vi.fn(
  async (_token: string, _chatId: string, _text: string) => null as string | null,
)
vi.mock('./nativeEngine', () => ({
  sendTelegram: (token: string, chatId: string, text: string) =>
    sendTelegramMock(token, chatId, text),
}))

import {
  configureTelegram,
  notifyManagerReport,
  notifyNeedsYou,
  notifyNotice,
  resetNeedsYouForTest,
} from './telegramNotify'

describe('telegramNotify — courtesy mirror, honest and quiet by default', () => {
  beforeEach(() => {
    sendTelegramMock.mockClear()
    resetNeedsYouForTest()
    configureTelegram({ enabled: true, token: 't', chatId: 'c' })
  })

  it('sends nothing at all when disabled or unconfigured', () => {
    configureTelegram({ enabled: false, token: 't', chatId: 'c' })
    notifyNotice('done', 'x')
    notifyManagerReport('M', 'job', true)
    notifyNeedsYou(3)
    configureTelegram({ enabled: true, token: '', chatId: 'c' })
    notifyNotice('done', 'x')
    expect(sendTelegramMock).not.toHaveBeenCalled()
  })

  it('mirrors only outcome notices (done/attention), never info lines', () => {
    notifyNotice('info', 'step 2 of 5')
    expect(sendTelegramMock).not.toHaveBeenCalled()
    notifyNotice('done', '«Webs» is done — check it')
    notifyNotice('attention', '«Webs» needs attention')
    expect(sendTelegramMock).toHaveBeenCalledTimes(2)
    expect(String(sendTelegramMock.mock.calls[0][2])).toContain('✓')
    expect(String(sendTelegramMock.mock.calls[1][2])).toContain('⚠')
  })

  // Audit: failure notices append tool detail (git stderr…) after a colon —
  // that is CONTENT and must never egress to Telegram.
  it('strips detail after the first colon from mirrored notices', () => {
    notifyNotice('attention', '«Webs» — couldn’t return to main: fatal: not a git repository')
    const text = String(sendTelegramMock.mock.calls[0][2])
    expect(text).toContain('couldn’t return to main')
    expect(text).not.toContain('fatal')
    expect(text).not.toContain('git repository')
  })

  // Audit L4: the first poll of a session only SEEDS the baseline — items
  // that existed before launch were already reported once.
  it('needs-you: first poll seeds quietly, then fires on INCREASE only', () => {
    notifyNeedsYou(2) // seed — quiet
    expect(sendTelegramMock).not.toHaveBeenCalled()
    notifyNeedsYou(2) // steady — quiet
    notifyNeedsYou(1) // shrinking (user approving) — quiet
    expect(sendTelegramMock).not.toHaveBeenCalled()
    notifyNeedsYou(3) // grew — one nudge
    expect(sendTelegramMock).toHaveBeenCalledTimes(1)
  })

  // Audit: a manager summary is model output (possibly 🔒-local or
  // vault-derived) — the phone line is OUTCOME ONLY, details stay in the app.
  it('manager reports carry outcome only — never summary content', () => {
    notifyManagerReport('Compliance', 'weekly scan', false)
    const text = String(sendTelegramMock.mock.calls[0][2])
    expect(text).toContain('✗ Compliance · weekly scan — failed')
    expect(text).toContain('details in SC Prism')
  })
})
