import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import 'overlayscrollbars/styles/overlayscrollbars.css'
import './index.css'
import App from './App.tsx'
import { consumeRoomNavigation } from './features/room/room-navigation'

const initialNavigation = consumeRoomNavigation(window)

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // Service worker registration failed — app works without it
    })
  })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App initialNavigation={initialNavigation} />
  </StrictMode>,
)
