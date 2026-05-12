import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './i18n'
import App from './App.tsx'

// Force height constraints so flex-based scroll works inside App
document.documentElement.style.height = '100%'
document.documentElement.style.overflow = 'hidden'
document.body.style.height = '100%'
document.body.style.overflow = 'hidden'
const root = document.getElementById('root')!
root.style.height = '100%'

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
