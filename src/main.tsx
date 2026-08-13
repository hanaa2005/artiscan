import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/global.css'
import App from './App.tsx'

const container = document.getElementById('root')
if (container === null) {
  throw new Error('ArtiScan: عنصر ریشه با شناسه root پیدا نشد.')
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
