import { Component, type ErrorInfo, type ReactNode } from 'react'
import styles from './ErrorBoundary.module.css'
import { Button } from './Button'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

/** Catches render errors so a single failure never blanks the whole app (要件定義書 39). */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ErrorBoundary]', error, info.componentStack)
  }

  reset = (): void => this.setState({ error: null })

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className={styles.wrap}>
          <h2 className={styles.title}>エラーが発生しました</h2>
          <pre className={styles.message}>{this.state.error.message}</pre>
          <Button variant="primary" onClick={this.reset}>
            再試行
          </Button>
        </div>
      )
    }
    return this.props.children
  }
}
