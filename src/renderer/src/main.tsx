import React from 'react'
import ReactDOM from 'react-dom/client'
import LicensedApp from './LicensedApp'
import './styles.css'

document.documentElement.classList.toggle(
  'platform-windows',
  /Windows/i.test(navigator.userAgent)
)

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <LicensedApp />
  </React.StrictMode>
)
