import i18next from 'i18next'
import zh from '../../../locales/zh/translation.json' with { type: 'json' }
import en from '../../../locales/en/translation.json' with { type: 'json' }

const zhResources = zh as Record<string, unknown>
const enResources = en as Record<string, unknown>

/**
 * Detect language for the admin UI.
 * Priority: localStorage > browser language > 'en'
 */
export function detectAdminLang(): string {
  const stored = localStorage.getItem('llm-proxy-lang')
  if (stored === 'zh' || stored === 'en') return stored

  const navLang = (navigator.language || '').toLowerCase()
  if (navLang.startsWith('zh')) return 'zh'

  return 'en'
}

/**
 * Initialize i18next for the admin UI (browser environment).
 * Translations are bundled via esbuild JSON import.
 */
export function initAdminI18n(): void {
  if (i18next.isInitialized) return

  const lang = detectAdminLang()

  i18next.init({
    resources: {
      zh: { translation: zhResources },
      en: { translation: enResources },
    } as any,
    lng: lang,
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
  })
}

/**
 * Switch language and persist choice.
 */
export function switchLang(lang: string): void {
  localStorage.setItem('llm-proxy-lang', lang)
  i18next.changeLanguage(lang)
  window.location.reload()
}
