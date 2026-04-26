import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { useThemeStore, applyTheme } from './store/themeStore'

// Apply saved theme before first paint to avoid flash
applyTheme(useThemeStore.getState().theme)
// Keep <html> class in sync whenever the store changes
useThemeStore.subscribe((s) => applyTheme(s.theme))

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
