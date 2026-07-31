import i18next from 'i18next'
import { initReactI18next } from 'react-i18next'
// admin-ui/src 上溯两级到仓库根目录的 locales/
import zh from '../../locales/zh/translation.json'
import en from '../../locales/en/translation.json'

const zhResources = zh as Record<string, unknown>
const enResources = en as Record<string, unknown>

/**
 * 检测 admin UI 语言。
 * 优先级：localStorage > 浏览器语言 > 'en'
 */
export function detectAdminLang(): string {
  const stored = localStorage.getItem('llm-proxy-lang')
  if (stored === 'zh' || stored === 'en') return stored

  const navLang = (navigator.language || '').toLowerCase()
  if (navLang.startsWith('zh')) return 'zh'

  return 'en'
}

/**
 * 初始化 admin UI 的 i18next（浏览器环境）。
 * 翻译资源通过 JSON import 内联打包。返回 i18next 实例供 I18nextProvider 使用。
 */
export function initAdminI18n(): typeof i18next {
  if (!i18next.isInitialized) {
    const lang = detectAdminLang()

    void i18next.use(initReactI18next).init({
      resources: {
        zh: { translation: zhResources },
        en: { translation: enResources },
      } as any,
      lng: lang,
      fallbackLng: 'en',
      interpolation: { escapeValue: false },
    })
  }
  return i18next
}

/**
 * 切换语言并持久化当前浏览器的界面偏好。
 * react-i18next 会自动触发重渲染，无需 location.reload。
 */
export async function switchLang(lang: string): Promise<void> {
  localStorage.setItem('llm-proxy-lang', lang)
  await i18next.changeLanguage(lang)
}
