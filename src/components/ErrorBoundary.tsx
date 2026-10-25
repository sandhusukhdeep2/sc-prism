import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import './ErrorBoundary.css'

// App-wide error boundary. Catches render/lifecycle errors in the routed tree
// and shows a graceful cream + gold panel instead of a blank white screen.
// "Reload view" resets the boundary so the same route can re-render.

type Props = { children: ReactNode }
type State = { error: Error | null }

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surface for diagnostics; the panel already shows the message to the user.
    console.error('ErrorBoundary caught an error:', error, info.componentStack)
  }

  reset = (): void => {
    this.setState({ error: null })
  }

  render(): ReactNode {
    const { error } = this.state
    if (error === null) return this.props.children

    return (
      <div className="errb" role="alert">
        <div className="errb__panel">
          <span className="errb__badge mono">!</span>
          <h1 className="errb__title">Something went wrong</h1>
          <p className="errb__msg">
            This view hit an unexpected error and stopped rendering. Your vault is
            safe — every write is validated before it lands.
          </p>
          <pre className="errb__detail mono">{error.message || String(error)}</pre>
          <button type="button" className="errb__btn" onClick={this.reset}>
            Reload view
          </button>
        </div>
      </div>
    )
  }
}
