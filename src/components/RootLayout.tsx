import { Outlet } from 'react-router-dom'
import ErrorBoundary from './ErrorBoundary'

// Top-level layout: each route renders through the Outlet, wrapped in an
// ErrorBoundary so a render error in one route can't blank the whole app.
// (The 01–21 design-walkthrough navigator was a dev aid and has been removed.)
export default function RootLayout() {
  return (
    <ErrorBoundary>
      <Outlet />
    </ErrorBoundary>
  )
}
