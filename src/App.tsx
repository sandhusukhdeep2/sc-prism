import { Routes, Route, Navigate } from 'react-router-dom'
import RootLayout from './components/RootLayout'
import AppShell from './components/AppShell'

// Onboarding (standalone, full-screen — no app chrome)
import Welcome from './pages/Welcome'
import Providers from './pages/Providers'
import CompanionWakes from './pages/CompanionWakes'
import CompanionGrants from './pages/CompanionGrants'
import VaultSetup from './pages/VaultSetup'
import GitHubAuth from './pages/GitHubAuth'
import Interview from './pages/Interview'
import GovernanceReview from './pages/GovernanceReview'

// App pages (inner content — rendered inside AppShell chrome)
import Workspace from './pages/Workspace'
import Editor from './pages/Editor'
import VerdictDetail from './pages/VerdictDetail'
import ApprovalGate from './pages/ApprovalGate'
import Vault from './pages/Vault'
import Stats from './pages/Stats'
import Console from './pages/Console'
import Settings from './pages/Settings'
import Automations from './pages/Automations'
import { ProjectsRedirect } from './pages/Projects'
import Agents from './pages/Agents'
import AgentDetail from './pages/AgentDetail'
import Skills from './pages/Skills'
import Memory from './pages/Memory'
import Training from './pages/Training'

export default function App() {
  return (
    <Routes>
      <Route element={<RootLayout />}>
        {/* onboarding — standalone */}
        <Route path="welcome" element={<Welcome />} />
        <Route path="providers" element={<Providers />} />
        <Route path="companion-wakes" element={<CompanionWakes />} />
        <Route path="vault-setup" element={<VaultSetup />} />
        <Route path="companion-grants" element={<CompanionGrants />} />
        <Route path="github" element={<GitHubAuth />} />
        <Route path="interview" element={<Interview />} />
        <Route path="governance-review" element={<GovernanceReview />} />

        {/* main app — inside the shell */}
        <Route element={<AppShell />}>
          <Route index element={<Workspace />} />
          <Route path="editor" element={<Editor />} />
          <Route path="verdict" element={<VerdictDetail />} />
          <Route path="approval" element={<ApprovalGate />} />
          <Route path="vault" element={<Vault />} />
          <Route path="stats" element={<Stats />} />
          <Route path="console" element={<Console />} />
          <Route path="settings" element={<Settings />} />
          <Route path="automations" element={<Automations />} />
          {/* The page was renamed Loop → Automations in the 2026-08-09 honesty
              pass; the URL lagged behind it. Old links (and any persisted
              location) keep working. */}
          <Route path="loop" element={<Navigate to="/automations" replace />} />
          <Route path="projects" element={<ProjectsRedirect />} />
          <Route path="agents" element={<Agents />} />
          <Route path="agents/:slug" element={<AgentDetail />} />
          <Route path="skills" element={<Skills />} />
          <Route path="memory" element={<Memory />} />
          <Route path="training" element={<Training />} />
        </Route>
      </Route>
    </Routes>
  )
}
