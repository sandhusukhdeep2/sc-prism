import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { ProjectsRedirect } from './Projects'
import { addProject } from '../lib/projects'
import { SettingsProvider } from '../lib/settings'
import { ConnectivityProvider } from '../lib/connectivity'
import { OnboardingProvider } from '../lib/onboarding'
import { AppProvider, useApp } from '../store/AppStore'

// Probe at "/" that renders the active project id so the test can assert
// the redirect landed AND (when applicable) the project was selected.
function ActiveProbe() {
  const { state } = useApp()
  return <div data-testid="active">{state.activeProjectId ?? 'none'}</div>
}

function renderAt(route: string) {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <SettingsProvider>
        <ConnectivityProvider>
          <OnboardingProvider>
            <AppProvider>
              <Routes>
                <Route path="/" element={<ActiveProbe />} />
                <Route path="/projects" element={<ProjectsRedirect />} />
              </Routes>
            </AppProvider>
          </OnboardingProvider>
        </ConnectivityProvider>
      </SettingsProvider>
    </MemoryRouter>,
  )
}

describe('Projects deep link (?open=<projectId>) redirects into the Work page', () => {
  beforeEach(() => {
    ;(window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {}
    localStorage.clear()
  })
  afterEach(() => {
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
    localStorage.clear()
  })

  it('redirects to the Work page and selects the project named by ?open=', async () => {
    const project = addProject('Deep Link Target', 'ship it', '', '/tmp/deep-link-target')
    renderAt(`/projects?open=${project.id}`)
    // Landed on "/" (the probe) with that project active.
    expect(await screen.findByTestId('active')).toHaveTextContent(project.id)
  })

  it('redirects to the Work page with no project selected when the id does not exist', async () => {
    addProject('Some Other Project', 'goal', '', '/tmp/some-other-project')
    renderAt('/projects?open=does-not-exist')
    expect(await screen.findByTestId('active')).toHaveTextContent('none')
  })

  it('redirects to the Work page with no project selected when there is no ?open=', async () => {
    renderAt('/projects')
    expect(await screen.findByTestId('active')).toHaveTextContent('none')
  })
})
