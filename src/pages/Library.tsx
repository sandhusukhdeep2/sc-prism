// LIBRARY (design 2026-11-08 §D): Skills, Memory, Vault and Training as tabs
// of one page, so the rail lists one place instead of four. The pages are
// untouched and their own routes still render; this is a container and a
// tablist, nothing more. The open tab lives in the URL (`?tab=memory`) so a
// link can open one; an unknown tab falls back to Skills rather than a blank.
import { useSearchParams } from 'react-router-dom'
import Skills from './Skills'
import Memory from './Memory'
import Vault from './Vault'
import Training from './Training'
import './Library.css'

const TABS = [
  { id: 'skills', label: 'Skills', Page: Skills },
  { id: 'memory', label: 'Memory', Page: Memory },
  { id: 'vault', label: 'Vault', Page: Vault },
  { id: 'training', label: 'Training', Page: Training },
] as const

type TabId = (typeof TABS)[number]['id']

function tabFrom(raw: string | null): TabId {
  return (TABS.find((t) => t.id === raw)?.id ?? 'skills') as TabId
}

export default function Library() {
  const [params, setParams] = useSearchParams()
  const open = tabFrom(params.get('tab'))
  const current = TABS.find((t) => t.id === open) ?? TABS[0]
  const Page = current.Page
  return (
    <div className="library">
      <div className="library__tabs" role="tablist" aria-label="Library sections">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`library-tab-${t.id}`}
            aria-selected={t.id === open}
            aria-controls="library-panel"
            className={'library__tab' + (t.id === open ? ' library__tab--on' : '')}
            onClick={() => setParams({ tab: t.id }, { replace: true })}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div id="library-panel" role="tabpanel" aria-labelledby={`library-tab-${current.id}`} className="library__panel">
        <Page />
      </div>
    </div>
  )
}
