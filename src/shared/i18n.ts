import i18next from 'i18next'
import { zhCN } from './locales/zh-CN'

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'common'
    resources: typeof zhCN
  }
}

export const i18nOptions = {
  lng: 'zh-CN',
  fallbackLng: 'zh-CN',
  defaultNS: 'common',
  resources: { 'zh-CN': zhCN },
  interpolation: { escapeValue: false },
} as const

export { i18next }
