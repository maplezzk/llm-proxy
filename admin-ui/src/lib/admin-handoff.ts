import { parseAdminHandoffFragment } from './client-settings'

export interface AdminHandoffBootstrapDependencies {
  hash: string
  pathname: string
  search: string
  replaceURL: (url: string) => void
  exchange: (code: string) => Promise<string>
  saveCredential: (credential: string) => void
  showManualEntry: () => void
}

export async function bootstrapAdminHandoff(
  dependencies: AdminHandoffBootstrapDependencies,
): Promise<'none' | 'success' | 'failed'> {
  const handoff = parseAdminHandoffFragment(dependencies.hash)
  if (!handoff) return 'none'

  // 必须先清理当前历史记录，再发出任何网络请求。
  dependencies.replaceURL(
    `${dependencies.pathname}${dependencies.search}#${handoff.tab || 'dashboard'}`,
  )
  try {
    const credential = (await dependencies.exchange(handoff.code)).trim()
    if (!credential) throw new Error('empty credential')
    dependencies.saveCredential(credential)
    return 'success'
  } catch {
    dependencies.showManualEntry()
    return 'failed'
  }
}
