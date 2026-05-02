import i18next, { type TFunction } from 'i18next'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Global t function, set once during createI18n()
let currentT: TFunction = ((key: string) => key) as unknown as TFunction

/**
 * Initialize i18next with zh/en resources.
 * Call once at app startup. Returns t() and changeLanguage().
 */
export function createI18n(lang: string): { t: TFunction; changeLanguage: (l: string) => void } {
  const zh = loadTranslation('zh')
  const en = loadTranslation('en')

  if (!i18next.isInitialized) {
    i18next.init({
      resources: {
        zh: { translation: zh },
        en: { translation: en },
      } as any,
      lng: lang,
      fallbackLng: 'en',
      interpolation: { escapeValue: false },
      initImmediate: false,
    } as any)
  } else {
    i18next.changeLanguage(lang)
  }

  currentT = i18next.t

  return {
    t: i18next.t,
    changeLanguage: (l: string) => { i18next.changeLanguage(l) },
  }
}

/**
 * Global t() function. Must call createI18n() before use.
 */
export function t(key: string, options?: Record<string, unknown>): string {
  return currentT(key, options)
}

/**
 * Detect language from env variable like LANG, LC_ALL, etc.
 * - "zh_CN.UTF-8" -> "zh"
 * - "en_US.UTF-8" -> "en"
 * Falls back to "en".
 */
export function detectLang(envLang?: string): string {
  if (envLang) {
    const normalized = envLang.toLowerCase().replace(/[^a-z]/g, '')
    if (normalized.startsWith('zh')) return 'zh'
    if (normalized.startsWith('en')) return 'en'
  }
  return 'en'
}

function loadTranslation(lang: string): Record<string, unknown> {
  const localesDir = resolve(__dirname, '..', '..', 'locales')
  try {
    const content = readFileSync(resolve(localesDir, lang, 'translation.json'), 'utf-8')
    return JSON.parse(content)
  } catch (err) {
    console.warn(`[i18n] Failed to load ${lang} translation:`, err)
    return {}
  }
}
