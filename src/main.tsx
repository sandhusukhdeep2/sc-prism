// Bundled typefaces — shipped IN the app, never borrowed from the OS.
// tokens.css named 'Hanken Grotesk'/'JetBrains Mono' while shipping neither,
// so every screen silently fell back to the system font. Now they're real.
import '@fontsource-variable/outfit'
import '@fontsource-variable/jetbrains-mono'
import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import { AppProvider } from './store/AppStore'
import { SettingsProvider } from './lib/settings'
import { ConnectivityProvider } from './lib/connectivity'
import { OnboardingProvider } from './lib/onboarding'
import './theme/tokens.css'
import './theme/global.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <SettingsProvider>
        <ConnectivityProvider>
          <OnboardingProvider>
            <AppProvider>
              <App />
            </AppProvider>
          </OnboardingProvider>
        </ConnectivityProvider>
      </SettingsProvider>
    </BrowserRouter>
  </React.StrictMode>,
)
