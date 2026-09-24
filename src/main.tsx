import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import { registerServiceWorker } from './app/registerServiceWorker'
import './styles/global.css'

const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('#root not found')

createRoot(rootElement).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)

registerServiceWorker()
