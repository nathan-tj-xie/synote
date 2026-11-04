import { createRoot } from 'react-dom/client'
import { initReactI18next } from 'react-i18next'
import { i18next, i18nOptions } from '../../shared/i18n'
import { App } from './App'
import { applyTokens } from './tokens'
import './global.css'

applyTokens()
i18next.use(initReactI18next).init(i18nOptions)
createRoot(document.getElementById('root')!).render(<App />)
