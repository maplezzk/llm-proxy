import Alpine from 'alpinejs'
import { initStore } from './store.js'
import { dashboardPage } from './components/dashboard.js'
import { logsPage } from './components/logs.js'
import { providersPage } from './components/providers.js'
import { testPanel } from './components/test-panel.js'
import { adaptersPage } from './components/adapters.js'
import { proxyKeyForm } from './components/proxy-key.js'
import { capturePage } from './components/capture.js'

initStore()

Alpine.data('dashboardPage', dashboardPage)
Alpine.data('logsPage', logsPage)
Alpine.data('providersPage', providersPage)
Alpine.data('adaptersPage', adaptersPage)
Alpine.data('testPanel', testPanel)
Alpine.data('proxyKeyForm', proxyKeyForm)
Alpine.data('capturePage', capturePage)

;(window as any).Alpine = Alpine

// Alpine DOM init fires during Alpine.start()
document.addEventListener('alpine:init', () => {
  const store = Alpine.store('app') as any
  store.loadDashboard()
  store.startPolling()
})

Alpine.start()

// After start, attach hash routing
const store = Alpine.store('app') as any
const hashRoute = () => {
  const tab = location.hash.slice(1)
  if (tab && store.tabNames[tab]) store.switchTab(tab)
}
window.addEventListener('hashchange', hashRoute)
hashRoute()
