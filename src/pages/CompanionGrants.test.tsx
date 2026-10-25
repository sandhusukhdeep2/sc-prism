import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import CompanionGrants from './CompanionGrants'
import { SettingsProvider } from '../lib/settings'
import { OnboardingProvider } from '../lib/onboarding'

// The grant cards write REAL vault/telegram plumbing — stub the native edge
// only; everything else (settings context, flow) stays real.
const sendTelegramMock = vi.fn(
  async (_token: string, _chatId: string, _text: string) => null as string | null,
)
vi.mock('../lib/nativeEngine', async () => {
  const actual = await vi.importActual<typeof import('../lib/nativeEngine')>('../lib/nativeEngine')
  return {
    ...actual,
    // Audit C1: the page must resolve the vault path before any vault write —
    // give it a resolved dir so the tools card is operable in jsdom.
    resolveVaultDir: async () => '/resolved-vault',
    sendTelegram: (token: string, chatId: string, text: string) =>
      sendTelegramMock(token, chatId, text),
    readMcpApprovals: async () => ({ require: [], granted: ['files'] }),
    writeMcpApprovals: vi.fn(async () => true),
    readMcpServers: async () => [],
    writeMcpServers: vi.fn(async () => true),
    runNativeMcpList: async () => ({ ok: false as const, error: 'not native in tests' }),
  }
})

function renderGrants() {
  return render(
    <MemoryRouter initialEntries={['/companion-grants']}>
      <SettingsProvider>
        <OnboardingProvider>
          <CompanionGrants />
        </OnboardingProvider>
      </SettingsProvider>
    </MemoryRouter>,
  )
}

describe('Companion grants — one ask per screen, Continue locked to the end', () => {
  beforeEach(() => {
    localStorage.clear()
    sendTelegramMock.mockClear()
    sendTelegramMock.mockResolvedValue(null)
  })
  afterEach(() => localStorage.clear())

  it('walks all seven asks; the summary reflects every real answer; Continue only at the end', async () => {
    renderGrants()

    // 1 files — grant project writes. No Continue anywhere yet.
    expect(screen.queryByText('Continue →')).toBeNull()
    fireEvent.click(screen.getByText('Grant — build real files'))

    // 2 web — deny.
    fireEvent.click(screen.getByText('Deny — stay offline'))
    // The new computer-control card (2026-08-31) — strict opt-in; the walk
    // denies it, matching the default a cautious user keeps.
    fireEvent.click(screen.getByText('Deny — hands off the machine'))
    fireEvent.click(screen.getByText('Deny — no commands'))

    // 3 tools — ask-first (writes the vault policy; async).
    await waitFor(() =>
      expect(screen.getByText('Ask me first (recommended)')).not.toBeDisabled(),
    )
    fireEvent.click(screen.getByText('Ask me first (recommended)'))
    await waitFor(() => expect(screen.getByText('Propose first (recommended)')).toBeInTheDocument())

    // 4 approvals — propose first.
    expect(screen.queryByText('Continue →')).toBeNull()
    fireEvent.click(screen.getByText('Propose first (recommended)'))

    // 5 telegram — skip.
    fireEvent.click(screen.getByText('Skip — no reports'))

    // summary states each REAL setting the flow wrote.
    expect(screen.getByText(/granted — ~\/SC Projects/)).toBeInTheDocument()
    expect(screen.getByText('denied')).toBeInTheDocument() // web
    // Ask-first, stated the way it now really behaves: reading runs, acting waits.
    expect(
      screen.getByText(/reading runs free — anything that changes something waits/),
    ).toBeInTheDocument()
    expect(screen.getByText('propose first')).toBeInTheDocument()
    expect(screen.getAllByText('off').length).toBeGreaterThan(0) // blocking + telegram
    expect(screen.getByText('Continue →')).toBeInTheDocument()
  })

  it('telegram grant stays locked until a REAL delivery, then unlocks', async () => {
    renderGrants()
    fireEvent.click(screen.getByText('Grant — build real files'))
    fireEvent.click(screen.getByText('Grant web access'))
    fireEvent.click(screen.getByText('Deny — hands off the machine'))
    fireEvent.click(screen.getByText('Deny — no commands'))
    await waitFor(() => expect(screen.getByText('Allow within the gates')).not.toBeDisabled())
    fireEvent.click(screen.getByText('Allow within the gates'))
    await waitFor(() => expect(screen.getByText('Propose first (recommended)')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Run automatically'))

    // Locked before any proof of delivery.
    const locked = screen.getByText('Delivery not proven yet') as HTMLButtonElement
    expect(locked.disabled).toBe(true)

    fireEvent.change(screen.getByLabelText('Telegram bot token'), { target: { value: '123:abc' } })
    fireEvent.change(screen.getByLabelText('Telegram chat id'), { target: { value: '42' } })
    fireEvent.click(screen.getByText('Send test message'))
    await waitFor(() => expect(screen.getByText(/✓ delivered/)).toBeInTheDocument())
    expect(screen.getByText('Reports on — continue')).toBeInTheDocument()

    // A failed send must NOT unlock (fresh render, error path).
    sendTelegramMock.mockResolvedValue('telegram said 401: Unauthorized')
  })

  it('a failed test message keeps the grant locked and says why', async () => {
    sendTelegramMock.mockResolvedValue('telegram said 401: Unauthorized')
    renderGrants()
    fireEvent.click(screen.getByText('Grant — build real files'))
    fireEvent.click(screen.getByText('Grant web access'))
    fireEvent.click(screen.getByText('Deny — hands off the machine'))
    fireEvent.click(screen.getByText('Deny — no commands'))
    await waitFor(() => expect(screen.getByText('Allow within the gates')).not.toBeDisabled())
    fireEvent.click(screen.getByText('Allow within the gates'))
    await waitFor(() => expect(screen.getByText('Propose first (recommended)')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Run automatically'))

    fireEvent.change(screen.getByLabelText('Telegram bot token'), { target: { value: '123:bad' } })
    fireEvent.change(screen.getByLabelText('Telegram chat id'), { target: { value: '42' } })
    fireEvent.click(screen.getByText('Send test message'))
    await waitFor(() => expect(screen.getByText(/not delivered — telegram said 401/)).toBeInTheDocument())
    expect((screen.getByText('Delivery not proven yet') as HTMLButtonElement).disabled).toBe(true)
  })
})
