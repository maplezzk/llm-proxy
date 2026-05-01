const { app, Tray, Menu, nativeImage, BrowserWindow } = require('electron')
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

// ── Tray icon (18x18 PNG as base64) ──
const TRAY_ICON_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAABIAAAASCAYAAABWzo5XAAAAAXNSR0IArs4c6QAAATRJREFUOE' +
  '+tk79KA0EQxr+Z2as4FdJYBCxs7ewEeQELH0DfwCfwDcQH8AFs8wAWNnYCdhZaWIiFKFhYCVY2' +
  'gghKKKJiLpfs7e3uzM6u5M8GyXyzP76Zndn8ZhZCiBBCCCEUOMe4mUIphZTSQgjBGGN93/eFE' +
  'GQYhuT7Pi2KoqjXaJqWRVFExWLRNE3TdF1XAOB7P1YUBYQQYlU8RFEU1XXdsG07mKZpOE1TGo' +
  'ZhkKbpMI5j6vu+5/s+930/z/N8MBgM1nXdPNM0LQAAjuN4FAqFgmma/Xa7Xeic2+12jwAkSRK' +
  '/iUajeL/f5+v1+uR2u5MA/BWjAbtarVYFABv9R0S0Q+mmlTIMw7rWugiCwKhpNY/04sqSWnjn' +
  'z5dKJZemqQMsI0LI3oDn4HPJcRzH7ytv4EI5Hn4xMAAAAASUVORK5CYII='

// ── Proxy management ──

function getProxyBinary() {
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

function apiGet(apiPath) {
  return new Promise(resolve => {
    http.get(`http://127.0.0.1:${PROXY_PORT}${apiPath}`, res => {
      let data = ''
      res.on('data', c => data += c)
      res.on('end', () => { try { resolve(JSON.parse(data)) } catch { resolve(null) } })
    }).on('error', () => resolve(null))
  })
}

function apiPut(apiPath, body) {
  return new Promise(resolve => {
    const d = JSON.stringify(body)
    const req = http.request({
      hostname: '127.0.0.1', port: PROXY_PORT, path: apiPath,
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
  return {
    running: health?.success === true,
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
  const items = []

  items.push({ label: state.running ? '●  llm-proxy 运行中' : '○  llm-proxy 未运行', enabled: false })
  items.push({ type: 'separator' })

  if (state.running) {
    items.push({ label: '⏹ 停止服务', click: () => handleToggle() })
    items.push({ label: '↺ 重启服务', click: () => handleRestart() })
  } else {
    items.push({ label: '▶ 启动服务', click: () => handleToggle() })
  }

  items.push({ type: 'separator' })

  if (state.adapters.length === 0) {
    items.push({ label: '无法连接到 llm-proxy', enabled: false })
  } else {
    for (const adapter of state.adapters) {
      items.push({ label: adapter.name, enabled: false })
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
        if (submenu.length && submenu[submenu.length - 1].type === 'separator') submenu.pop()
        items.push({ label: '  ' + mapping.sourceModelId, submenu })
      }
      items.push({ type: 'separator' })
    }
  }

  items.push({ label: '刷新', click: () => rebuildMenu() })

  const logLevel = state.logLevel || 'info'
  items.push({
    label: `日志级别: ${logLevel}`,
    submenu: ['debug', 'info', 'warn', 'error'].map(l => ({
      label: l === logLevel ? '✓ ' + l : '  ' + l,
      click: () => handleLogLevel(l),
    })),
  })

  items.push({ label: '打开 Admin UI', click: () => openAdmin() })
  items.push({ type: 'separator' })
  items.push({ label: '退出', click: () => app.quit() })

  tray.setContextMenu(Menu.buildFromTemplate(items))
}

// ── Handlers ──

async function handleToggle() {
  const running = await isPortOpen()
  if (running) {
    stopProxy()
    await waitFor(async () => !(await isPortOpen()), 3000)
  } else {
    startProxy()
    await waitFor(isPortOpen, 6000)
  }
  await rebuildMenu()
}

async function handleRestart() {
  stopProxy()
  await waitFor(async () => !(await isPortOpen()), 3000)
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
  app.setActivationPolicy('accessory')

  // Use app icon as tray icon (fallback to a colored 1px if not found)
  let icon
  try {
    icon = nativeImage.createFromPath(path.join(__dirname, '..', 'src', 'api', 'tray-icon.png'))
  } catch {}
  if (!icon || icon.isEmpty()) {
    // Create a simple colored icon: 18x18 with 3 white dots
    const size = 18
    const buf = Buffer.alloc(size * size * 4)
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 4
        const d1 = Math.sqrt((x - 5) ** 2 + (y - 5) ** 2)
        const d2 = Math.sqrt((x - 5) ** 2 + (y - 13) ** 2)
        const d3 = Math.sqrt((x - 13) ** 2 + (y - 9) ** 2)
        if (d1 <= 2 || d2 <= 2 || d3 <= 2) {
          buf[i] = 0; buf[i + 1] = 0; buf[i + 2] = 0; buf[i + 3] = 255
        }
      }
    }
    icon = nativeImage.createFromBuffer(buf, { width: size, height: size })
  }
  icon = icon.resize({ width: 18, height: 18 })

  console.log('[electron] tray icon empty:', icon.isEmpty(), 'size:', icon.getSize())
  tray = new Tray(icon)
  if (process.platform === 'darwin') {
    // Auto-invert for dark/light mode
    tray.setImage(icon)
  }
  tray.setToolTip('LLM Proxy')
  console.log('[electron] tray created')

  startProxy()
  await waitFor(isPortOpen, 6000)

  console.log('[electron] building menu...')
  await rebuildMenu()
  console.log('[electron] ready')

  startPolling()
})

app.on('window-all-closed', () => {})

app.on('before-quit', () => {
  clearInterval(pollingTimer)
  stopProxy()
})
