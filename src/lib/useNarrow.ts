import { useEffect, useState } from 'react'

/**
 * True while the window matches `query` (default: the clear-room spec's
 * narrow breakpoint, 2026-11-09 §C). Guards for hosts without matchMedia
 * (jsdom) by reporting "not narrow", and follows live resizes.
 */
export function useNarrow(query = '(max-width: 1180px)'): boolean {
  const supported = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
  const [narrow, setNarrow] = useState<boolean>(() => (supported ? window.matchMedia(query).matches : false))
  useEffect(() => {
    if (!supported) return
    const mql = window.matchMedia(query)
    const onChange = () => setNarrow(mql.matches)
    onChange()
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', onChange)
      return () => mql.removeEventListener('change', onChange)
    }
    mql.addListener(onChange)
    return () => mql.removeListener(onChange)
  }, [query, supported])
  return narrow
}
