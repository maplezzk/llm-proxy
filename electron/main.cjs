const { app, Tray, Menu, nativeImage, BrowserWindow, dialog } = require('electron')
const { spawn } = require('child_process')
const path = require('path')
const http = require('http')
const net = require('net')

let tray = null
let proxyProcess = null
let adminWindow = null
let pollingTimer = null

const PROXY_PORT = parseInt(process.env.LLM_PROXY_PORT || '9000')
const ADMIN_URL = `http://127.0.0.1:${PROXY_PORT}/admin/`

// ── Proxy management ──

function getProxyBinary() {
  // In production, use llm-proxy CLI; in dev, use npm run dev
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'bin', 'llm-proxy')
  }
  return path.join(__dirname, '..', 'bin', 'llm-proxy.js')
}

function startProxy() {
  if (proxyProcess) return
  const bin = getProxyBinary()
  let cmd, args
  if (app.isPackaged) {
    cmd = bin
    args = ['start', '--port', String(PROXY_PORT)]
  } else {
    // Dev mode: use node to run the bin script (which uses tsx)
    cmd = 'node'
    args = [bin, 'start', '--port', String(PROXY_PORT)]
  }
  console.log('[electron] starting proxy:', cmd, args.join(' '))
  proxyProcess = spawn(cmd, args, {
    cwd: app.isPackaged ? process.resourcesPath : __dirname,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  proxyProcess.stdout?.on('data', d => console.log('[proxy]', d.toString().trim()))
  proxyProcess.stderr?.on('data', d => console.error('[proxy]', d.toString().trim()))
  proxyProcess.on('exit', code => {
    console.log('[proxy] exited with', code)
    proxyProcess = null
  })
}

function stopProxy() {
  if (proxyProcess) {
    proxyProcess.kill('SIGTERM')
    setTimeout(() => {
      if (proxyProcess) proxyProcess.kill('SIGKILL')
    }, 3000)
  }
}

function isPortOpen() {
  return new Promise(resolve => {
    const s = net.connect(PROXY_PORT, '127.0.0.1', () => { s.destroy(); resolve(true) })
    s.on('error', () => resolve(false))
  })
}

// ── API helpers ──

function apiGet(path) {
  return new Promise(resolve => {
    http.get(`http://127.0.0.1:${PROXY_PORT}${path}`, res => {
      let data = ''
      res.on('data', c => data += c)
      res.on('end', () => { try { resolve(JSON.parse(data)) } catch { resolve(null) } })
    }).on('error', () => resolve(null))
  })
}

function apiPut(path, body) {
  return new Promise(resolve => {
    const d = JSON.stringify(body)
    const req = http.request({
      hostname: '127.0.0.1', port: PROXY_PORT, path,
      method: 'PUT', headers: { 'Content-Type': 'application/json', 'Content-Length': d.length }
    }, res => resolve(res.statusCode === 200))
    req.on('error', () => resolve(false))
    req.write(d)
    req.end()
  })
}

// ── State ──

async function refreshState() {
  const [health, adapters, config, logLevel] = await Promise.all([
    apiGet('/admin/health'),
    apiGet('/admin/adapters'),
    apiGet('/admin/config'),
    apiGet('/admin/log-level'),
  ])
  const running = health?.success === true
  return {
    running,
    adapters: adapters?.data?.adapters || [],
    providers: config?.data?.providers || [],
    logLevel: logLevel?.data?.level || 'info',
  }
}

async function switchMapping(adapterName, sourceModelId, provider, targetModelId) {
  const state = await refreshState()
  const adapter = state.adapters.find(a => a.name === adapterName)
  if (!adapter) return false
  const models = adapter.models.map(m => ({
    sourceModelId: m.sourceModelId,
    provider: m.sourceModelId === sourceModelId ? provider : m.provider,
    targetModelId: m.sourceModelId === sourceModelId ? targetModelId : m.targetModelId,
  }))
  return apiPut(`/admin/adapters/${adapterName}`, { name: adapter.name, type: adapter.type, models })
}

async function setLogLevel(level) {
  return apiPut('/admin/log-level', { level })
}

// ── Menu building ──

async function rebuildMenu() {
  if (!tray) return

  const state = await refreshState()
  const menuItems = []

  // Status
  const statusLabel = state.running ? '●  llm-proxy 运行中' : '○  llm-proxy 未运行'
  menuItems.push({ label: statusLabel, enabled: false })

  menuItems.push({ type: 'separator' })

  // Service control
  if (state.running) {
    menuItems.push({ label: '⏹ 停止服务', click: () => handleToggle() })
    menuItems.push({ label: '↺ 重启服务', click: () => handleRestart() })
  } else {
    menuItems.push({ label: '▶ 启动服务', click: () => handleToggle() })
  }

  menuItems.push({ type: 'separator' })

  // Adapters
  if (state.adapters.length === 0) {
    menuItems.push({ label: '无法连接到 llm-proxy', enabled: false })
  } else {
    for (const adapter of state.adapters) {
      menuItems.push({ label: adapter.name, enabled: false })
      for (const mapping of adapter.models) {
        const submenu = []
        for (const provider of state.providers) {
          for (const model of provider.models) {
            const isChecked = provider.name === mapping.provider && model.id === mapping.targetModelId
            submenu.push({
              label: (isChecked ? '✓ ' : '  ') + `${provider.name}/${model.id}`,
              type: 'radio',
              checked: isChecked,
              click: () => handleSwitch(adapter.name, mapping.sourceModelId, provider.name, model.id),
            })
          }
          submenu.push({ type: 'separator' })
        }
        // Remove trailing separator
        if (submenu.length && submenu[submenu.length - 1].type === 'separator') submenu.pop()
        menuItems.push({ label: '  ' + mapping.sourceModelId, submenu })
      }
      menuItems.push({ type: 'separator' })
    }
  }

  // Actions
  menuItems.push({ label: '刷新', click: () => rebuildMenu() })

  // Log level
  const logLevel = state.logLevel || 'info'
  menuItems.push({
    label: `日志级别: ${logLevel}`,
    submenu: ['debug', 'info', 'warn', 'error'].map(l => ({
      label: l === logLevel ? '✓ ' + l : '  ' + l,
      click: () => handleLogLevel(l),
    })),
  })

  menuItems.push({ label: '打开 Admin UI', click: () => openAdmin() })

  menuItems.push({ type: 'separator' })
  menuItems.push({ label: '退出', click: () => app.quit() })

  const menu = Menu.buildFromTemplate(menuItems)
  tray.setContextMenu(menu)
}

// ── Handlers ──

async function handleToggle() {
  const running = await isPortOpen()
  if (running) {
    stopProxy()
    await waitFor(!isPortOpen, 3000)
  } else {
    startProxy()
    await waitFor(isPortOpen, 6000)
  }
  await rebuildMenu()
}

async function handleRestart() {
  stopProxy()
  await waitFor(!isPortOpen, 3000)
  startProxy()
  await waitFor(isPortOpen, 6000)
  await rebuildMenu()
}

async function handleSwitch(adapterName, sourceModelId, provider, targetModelId) {
  await switchMapping(adapterName, sourceModelId, provider, targetModelId)
  await rebuildMenu()
}

async function handleLogLevel(level) {
  await setLogLevel(level)
  await rebuildMenu()
}

function openAdmin() {
  if (adminWindow) {
    adminWindow.show()
    adminWindow.focus()
    return
  }
  adminWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    title: 'LLM Proxy',
    webPreferences: { nodeIntegration: false },
  })
  adminWindow.loadURL(ADMIN_URL)
  adminWindow.on('closed', () => { adminWindow = null })
}

function waitFor(condition, maxMs) {
  const start = Date.now()
  return new Promise(resolve => {
    const check = async () => {
      if (await condition() || Date.now() - start > maxMs) return resolve()
      setTimeout(check, 200)
    }
    check()
  })
}

// ── Polling ──

function startPolling() {
  pollingTimer = setInterval(() => rebuildMenu(), 10000)
}

// ── App lifecycle ──

app.whenReady().then(async () => {
  // Create tray
  const iconPath = path.join(__dirname, '..', 'src', 'api', 'tray-icon.png')
  console.log('[electron] tray icon path:', iconPath, 'exists:', require('fs').existsSync(iconPath))
  const icon = nativeImage.createFromPath(iconPath)
  if (icon.isEmpty()) console.error('[electron] tray icon is empty!')
  tray = new Tray(icon.resize({ width: 18, height: 18 }))
  // macOS: treat as template image for dark mode support
  if (process.platform === 'darwin') {
    tray.setIgnoreDoubleClickEvents(true)
  }
  tray.setToolTip('LLM Proxy')
  console.log('[electron] tray created')

  // Start proxy
  startProxy()
  await waitFor(isPortOpen, 6000)

  // Build menu
  console.log('[electron] building menu...')
  await rebuildMenu()
  console.log('[electron] menu built, ready')

  // Polling
  startPolling()
})

app.on('window-all-closed', () => {
  // Don't quit on window close - stay in tray
})

app.on('before-quit', () => {
  clearInterval(pollingTimer)
  stopProxy()
})
