import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/index.css'
import App from './App.tsx'
import { StoreProvider } from './store'
import { JobServiceProvider } from './job'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <StoreProvider>
      <JobServiceProvider>
        <App />
      </JobServiceProvider>
    </StoreProvider>
  </StrictMode>,
)
