import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles/global.css'

// Stage 6 wraps this in i18n, theme, and error-boundary providers.

const container = document.getElementById('root')
if (!container) throw new Error('root element missing from index.html')

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
