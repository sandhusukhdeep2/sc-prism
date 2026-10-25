// The ONE reader of a web tool_exec span's disclosure attrs. Everything the
// console, the run stream and the narration say about a web call comes through
// here, so its rules are the contract:
//
//   1. Only what the span REALLY carried. A missing attr yields '' / undefined
//      and the caller falls back to its generic phrase — never a guessed host,
//      never a guessed status.
//   2. 0 is a real answer (a search that found nothing), and must survive.
//   3. THE PRIVACY LINE: this module reads WEB attrs only, because a web
//      argument already left the machine. There is deliberately no reader here
//      for vault/MCP arguments — the engine never records them.
import { describe, expect, it } from 'vitest'
import {
  formatBytes,
  hostOfUrl,
  webBytes,
  webHost,
  webQuery,
  webResultCount,
  webSpanDetail,
  webStatus,
} from './webSpan'

describe('hostOfUrl', () => {
  it('names the host of a real URL', () => {
    expect(hostOfUrl('https://docs.anthropic.com/en/docs/agents?x=1#y')).toBe('docs.anthropic.com')
  })
  it('strips userinfo and port so the label is just the host', () => {
    expect(hostOfUrl('http://u:p@internal-host:8080/a')).toBe('internal-host')
  })
  it('returns "" for anything that is not a URL — never a guess', () => {
    expect(hostOfUrl('not a url')).toBe('')
    expect(hostOfUrl('')).toBe('')
  })
})

describe('the attr readers never invent', () => {
  it('an empty attrs bag yields nothing at all', () => {
    expect(webHost({})).toBe('')
    expect(webQuery({})).toBe('')
    expect(webStatus({})).toBeUndefined()
    expect(webBytes({})).toBeUndefined()
    expect(webResultCount({})).toBeUndefined()
    expect(webSpanDetail({}, 'web_fetch')).toBe('')
    expect(webSpanDetail({}, 'web_search')).toBe('')
  })

  it('rejects attrs of the wrong type rather than coercing them', () => {
    expect(webStatus({ status: '200' })).toBeUndefined()
    expect(webBytes({ bytes: -1 })).toBeUndefined()
    expect(webHost({ host: 42 })).toBe('')
  })

  it('prefers the engine-parsed host but derives one from the url otherwise', () => {
    expect(webHost({ host: 'a.example', url: 'https://b.example/' })).toBe('a.example')
    expect(webHost({ url: 'https://b.example/x' })).toBe('b.example')
  })

  it('keeps 0 results — "found nothing" is an answer, not an absence', () => {
    expect(webResultCount({ result_count: 0 })).toBe(0)
    expect(webSpanDetail({ query: 'q', result_count: 0 }, 'web_search')).toBe('"q" — 0 results')
  })
})

describe('formatBytes', () => {
  it('reads at a glance at every scale', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(49152)).toBe('48 KB')
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB')
  })
})

describe('webSpanDetail — the line the user finally sees', () => {
  it('a fetch: <host> — <status>, <size>', () => {
    expect(
      webSpanDetail(
        { host: 'docs.anthropic.com', url: 'https://docs.anthropic.com/x', status: 200, bytes: 49152 },
        'web_fetch',
      ),
    ).toBe('docs.anthropic.com — 200, 48 KB')
  })

  it('a search: "<query>" — <n> results', () => {
    expect(webSpanDetail({ query: 'mlx speculative decoding', result_count: 8 }, 'web_search')).toBe(
      '"mlx speculative decoding" — 8 results',
    )
  })

  it('says result (singular) for one hit', () => {
    expect(webSpanDetail({ query: 'q', result_count: 1 }, 'web_search')).toBe('"q" — 1 result')
  })

  it('degrades gracefully — a host with no outcome yet is just the host', () => {
    expect(webSpanDetail({ host: 'example.com' }, 'web_fetch')).toBe('example.com')
  })

  it('a status with no host is still worth saying', () => {
    expect(webSpanDetail({ status: 500 }, 'web_fetch')).toBe('500')
  })
})
