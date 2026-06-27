import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './i18n'
import App from './App.tsx'
import { IS_DEMO, installDemoFetch } from './demo-mode'

// In the static demo build there is no backend — route /api/* to frozen JSON
// before the first render so the very first data fetch already hits the shim.
if (IS_DEMO) installDemoFetch()

const root = document.getElementById('root')!

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
