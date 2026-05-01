---
date: 2026-04-26
topic: admin-ui-alpine-migration
---

# Implementation Plan: Admin UI Alpine.js Migration

## Current State

**File**: `/Users/zzk/CliProject/llm-proxy/src/api/admin-ui.html` (911 lines, single HTML SPA)

**Structure**:
- CSS styles (lines 7-241): 235 lines of clean CSS -- unchanged throughout
- HTML body (lines 243-402): sidebar, topbar, 4 pages, 4 modals, toast container
- Vanilla JS (lines 404-909): ~500 lines with 9 global variables and manual DOM manipulation

**Global variables to eliminate**:
| Variable | Line | Used by |
|----------|------|---------|
| `_confirmResolve` | 415 | confirm dialog |
| `_allLogs` | 489 | logs page |
| `_logFilter` | 490 | logs filter |
| `_allProviders` | 520 | providers table |
| `_cachedConfig` | 521 | providers, adapters, test panel |
| `_allAdapters` | 557 | adapters table |
| `_pullModelsData` | 660 | pull models modal |
| `editingProvider` | 732 | provider CRUD |
| `editingAdapter` | 793 | adapter CRUD |

**Manual DOM patterns** (all to be replaced):
- `document.getElementById('...').innerHTML = ...` (6 table renderers)
- `document.getElementById('...').classList.add/remove('open')` (modal toggle)
- `document.getElementById('...').value = ...` (form field set/reset)
- `document.createElement()` + `appendChild()` (dynamic rows)
- `onclick="fn()"` / `oninput="fn()"` (inline event handlers)

**Backend API**: `/Users/zzk/CliProject/llm-proxy/src/api/server.ts` (120 lines) -- serves admin-ui.html verbatim at route `/admin` (line 50-53). API handlers live in `/Users/zzk/CliProject/llm-proxy/src/api/handlers/` directory. No backend changes needed.

**Build**: `/Users/zzk/CliProject/llm-proxy/package.json` -- `build` script copies admin-ui.html to dist (line 11). No frontend build tools.

---

## Build Architecture Change: CDN → npm + esbuild

Alpine.js 通过 `npm install alpinejs` 安装，esbuild 打包为独立 JS chunk，admin-ui.html 引用 bundle 而非 CDN。

Key changes from traditional approach:
- No `<script defer src="//cdn...">` tag
- Alpine source modules in `src/api/admin/` directory
- esbuild bundles to `dist/api/admin-app.js`
- server.ts serves `/admin-app.js` as static route
- admin-ui.html includes `<script src="/admin-app.js" defer>`

---

## Phase 0: Foundation (Framework-independent, zero functional change)

### Goal
Install Alpine.js, create admin source directory, update build pipeline, serve bundled JS. Existing HTML/JS continues to work untouched.

### Files changed/created
- `package.json` — add alpinejs dependency
- `src/api/admin/app.ts` — Alpine entry point (NEW)
- `src/api/admin/store.ts` — Alpine.store('app') definition (NEW)
- `src/api/admin/types.ts` — shared API types (NEW)
- `src/api/admin-ui.html` — add `<script>` tag + x-cloak CSS
- `src/api/server.ts` — add `/admin-app.js` route
- `package.json` — update `build` script

### Steps

#### 0a. Install Alpine.js

```bash
npm install alpinejs
```

#### 0b. Create src/api/admin/ directory

```
src/api/admin/
├── app.ts          # Entry: imports Alpine, registers components
├── store.ts        # Alpine.store('app') definition
├── types.ts        # Shared API type definitions
└── components/     # Per-page Alpine components (added in later phases)
    ├── dashboard.ts
    ├── logs.ts
    ├── providers.ts
    ├── adapters.ts
    └── test-panel.ts
```

#### 0c. Create `src/api/admin/types.ts`

```typescript
// Shared type definitions for Admin API contracts

export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
}

export type ProviderType = 'openai' | 'anthropic';

export interface ProviderModel {
  id: string;
}

export interface ProviderConfig {
  name: string;
  type: ProviderType;
  api_key?: string;
  api_base?: string;
  models: ProviderModel[];
}

export interface ProviderStatus extends ProviderConfig {
  available: boolean;
}

export interface AdapterMapping {
  sourceModelId: string;
  provider: string;
  targetModelId: string;
  status?: 'ok' | 'error';
}

export interface AdapterConfig {
  name: string;
  type: ProviderType;
  models: AdapterMapping[];
}

export interface AppConfig {
  providers: ProviderConfig[];
  adapters: AdapterConfig[];
}

export interface LogEntry {
  timestamp: string;
  type: 'request' | 'system';
  message: string;
  details?: any;
}
```

#### 0d. Create `src/api/admin/store.ts`

```typescript
import Alpine from 'alpinejs'

interface AppStore {
  config: any | null
  health: any | null
  status: 'loading' | 'running' | 'offline'
  currentTab: string
  tabNames: Record<string, string>
  confirmResolve: ((value: boolean) => void) | null
  showConfirm: boolean
  confirmMessage: string
  _dashboardInterval: ReturnType<typeof setInterval> | null
  fetch: (path: string, opts?: RequestInit) => Promise<any>
  toast: (message: string, type?: string) => void
  confirm: (msg: string) => Promise<boolean>
  switchTab: (tab: string) => void
  startPolling: () => void
  stopPolling: () => void
  loadDashboard: () => Promise<void>
}

export function initStore() {
  Alpine.store('app', {
    config: null,
    health: null,
    status: 'loading',
    currentTab: 'dashboard',
    tabNames: {
      dashboard: '仪表盘',
      logs: '日志',
      providers: '模型供应商',
      adapters: '适配器',
    },
    confirmResolve: null,
    showConfirm: false,
    confirmMessage: '',
    _dashboardInterval: null,

    async fetch(path: string, opts: RequestInit = {}) {
      const r = await fetch(path, {
        ...opts,
        headers: { 'Content-Type': 'application/json', ...opts.headers },
      })
      return r.json()
    },

    toast(message: string, type = 'info') {
      const el = document.createElement('div')
      el.className = 'toast toast-' + type
      el.textContent = message
      document.getElementById('toastContainer')!.appendChild(el)
      setTimeout(() => {
        el.style.opacity = '0'
        el.style.transition = 'opacity 0.3s'
        setTimeout(() => el.remove(), 300)
      }, 3000)
    },

    confirm(msg: string): Promise<boolean> {
      return new Promise(resolve => {
        this.confirmMessage = msg
        this.confirmResolve = resolve
        this.showConfirm = true
      })
    },

    switchTab(tab: string) {
      this.currentTab = tab
      location.hash = '#' + tab
    },

    startPolling() {
      if (this._dashboardInterval) return
      this._dashboardInterval = setInterval(() => this.loadDashboard(), 10000)
    },

    stopPolling() {
      if (this._dashboardInterval) {
        clearInterval(this._dashboardInterval)
        this._dashboardInterval = null
      }
    },

    async loadDashboard() {
      const [health, config] = await Promise.all([
        this.fetch('/admin/health').catch(() => null),
        this.fetch('/admin/config').catch(() => null),
      ])
      this.health = health
      this.config = config?.data ?? null
      this.status = health?.success ? 'running' : 'offline'
    },
  } satisfies AppStore as any)
}
```

#### 0e. Create `src/api/admin/app.ts` (entry point)

```typescript
import Alpine from 'alpinejs'
import { initStore } from './store.js'
import { dashboardPage } from './components/dashboard.js'
import { logsPage } from './components/logs.js'

// Init global store
initStore()

// Register page components (added incrementally per phase)
Alpine.data('dashboardPage', dashboardPage)
Alpine.data('logsPage', logsPage)

// Expose Alpine on window for old JS interop
;(window as any).Alpine = Alpine

// Mount Alpine
Alpine.start()
```

*Note: `providersPage`, `adaptersPage`, `testPanel` are registered in their respective phases.*

#### 0f. Add x-cloak CSS to admin-ui.html (after line 241, before `</style>`)

```css
[x-cloak] { display: none !important; }
```

#### 0g. Add Alpine bundle script tag to admin-ui.html (after x-cloak CSS, before `</head>`)

```html
<script defer src="/admin-app.js"></script>
```

#### 0h. Add `/admin-app.js` route to server.ts

Add route to `ROUTES` array:

```typescript
{
  method: 'GET',
  pattern: /^\/admin-app\.js$/,
  handler: handleAdminAppJs,
}
```

Add handler:

```typescript
let adminAppJs: string | null = null
function getAdminAppJs(): string {
  if (adminAppJs) return adminAppJs
  const __dirname = dirname(fileURLToPath(import.meta.url))
  const jsPath = join(__dirname, 'admin-app.js')
  try { adminAppJs = readFileSync(jsPath, 'utf-8') } catch { adminAppJs = 'console.warn("admin-app.js not found")' }
  return adminAppJs
}

const handleAdminAppJs: RouteHandler = (_ctx, _req, res) => {
  const js = getAdminAppJs()
  res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' })
  res.end(js)
}
```

#### 0i. Update build script in package.json

**BEFORE**:
```json
"build": "tsc && cp src/api/admin-ui.html dist/api/admin-ui.html"
```

**AFTER**:
```json
"build": "tsc && cp src/api/admin-ui.html dist/api/admin-ui.html && esbuild src/api/admin/app.ts --bundle --outfile=dist/api/admin-app.js --format=esm --minify"
```

### Verification
1. `npm run build` succeeds, produces `dist/api/admin-app.js`
2. Open browser to `/admin` — page renders identically
3. Console: `Alpine.store('app')` returns the store object
4. All existing tabs, modals, CRUD operations work exactly as before

---

## Phase 1: Dashboard + Sidebar/Status + Router (lowest risk)

### Goal
Migrate the simplest page (Dashboard) and the global router/sidebar/status bar to Alpine. These are pure-display components with no user input.

### Files changed
- `/Users/zzk/CliProject/llm-proxy/src/api/admin-ui.html`

### 1a. Sidebar navigation (lines 250-255)

**BEFORE** (lines 250-255):
```html
<div class="sidebar-nav">
  <a class="active" data-tab="dashboard"><span class="icon">◇</span><span>仪表盘</span></a>
  <a data-tab="logs"><span class="icon">≡</span><span>日志</span></a>
  <a data-tab="providers"><span class="icon">◎</span><span>模型供应商</span></a>
  <a data-tab="adapters"><span class="icon">◈</span><span>适配器</span></a>
</div>
```

**AFTER** (lines 250-255):
```html
<div class="sidebar-nav" x-data>
  <template x-for="tab in ['dashboard','logs','providers','adapters']" :key="tab">
    <a :class="{ active: $store.app.currentTab === tab }"
       :data-tab="tab"
       href="#"
       x-text="$store.app.tabNames[tab]"
       @click.prevent="$store.app.switchTab(tab)">
    </a>
  </template>
</div>
```

### 1b. Sidebar status (lines 256-259)

**BEFORE** (lines 256-259):
```html
<div class="sidebar-footer">
  <span class="dot" id="statusDot"></span>
  <span id="statusText">加载中</span>
</div>
```

**AFTER** (lines 256-259):
```html
<div class="sidebar-footer" x-data>
  <span class="dot" :class="{ running: $store.app.status === 'running' }"></span>
  <span x-text="$store.app.status === 'running' ? '运行中' : $store.app.status === 'offline' ? '未连接' : '加载中'"></span>
</div>
```

### 1c. Topbar (lines 263-266)

**BEFORE** (lines 263-266):
```html
<div class="topbar">
  <h2 id="pageTitle">仪表盘</h2>
  <span class="count" id="pageCount"></span>
</div>
```

**AFTER** (lines 263-266):
```html
<div class="topbar" x-data>
  <h2 x-text="$store.app.tabNames[$store.app.currentTab] || '仪表盘'"></h2>
</div>
```

Note: `#pageCount` (the count badge) was only used by `filterProviderTable()` and `filterAdapterTable()` -- those will be moved into the provider/adapter components in Phases 3 and 4.

### 1d. Dashboard page (lines 269-272)

**BEFORE** (lines 269-272):
```html
<!-- Dashboard -->
<div class="page active" id="page-dashboard">
  <div class="stats" id="statCards"></div>
</div>
```

**AFTER** (lines 269-272):
```html
<!-- Dashboard -->
<div class="page" id="page-dashboard"
     x-data="dashboardPage"
     :class="{ active: $store.app.currentTab === 'dashboard' }">
  <div class="stats">
    <template x-for="stat in stats" :key="stat.label">
      <div class="stat">
        <div class="label" x-text="stat.label"></div>
        <div class="value" :style="{ color: stat.clr }" x-text="stat.value"></div>
      </div>
    </template>
  </div>
</div>
```

**Note**: The `page.active` class is now managed by `:class="{ active: $store.app.currentTab === 'dashboard' }"`, not by JS tab-switching logic. The old `class="page active"` is changed to `class="page"`.

### 1e. Create `src/api/admin/components/dashboard.ts`

```typescript
export function dashboardPage() {
  return {
    get stats() {
      const store = (Alpine as any).store('app')
      const ok = store.health?.success
      const providers = store.config?.providers ?? []
      const modelCount = providers.reduce((s: number, p: any) => s + (p.models?.length ?? 0), 0)
      const adapters = store.config?.adapters ?? []
      return [
        { label: '运行状态', value: ok ? '正常' : '离线', clr: ok ? 'var(--success)' : 'var(--danger)' },
        { label: '供应商数', value: providers.length, clr: 'var(--text)' },
        { label: '模型总数', value: modelCount, clr: 'var(--text)' },
        { label: '适配器数', value: adapters.length, clr: 'var(--text)' },
      ]
    },
  }
}
```

### 1f. Update page routing for all 4 pages

Every page div gets the same `:class="{ active: $store.app.currentTab === '...' }"` pattern:

- `#page-dashboard`: add `:class="{ active: $store.app.currentTab === 'dashboard' }"` (done in 1d)
- `#page-logs`: add `:class="{ active: $store.app.currentTab === 'logs' }"`
- `#page-providers`: add `:class="{ active: $store.app.currentTab === 'providers' }"`
- `#page-adapters`: add `:class="{ active: $store.app.currentTab === 'adapters' }"`

### 1g. Confirm dialog (lines 329-336)

**BEFORE** (lines 329-336):
```html
<!-- Confirm Dialog -->
<div class="confirm-overlay" id="confirmModal"><div class="confirm-box">
  <p id="confirmMsg"></p>
  <div class="btn-row">
    <button class="btn btn-ghost" onclick="closeConfirm(false)">取消</button>
    <button class="btn btn-danger" id="confirmOkBtn" onclick="closeConfirm(true)">确定</button>
  </div>
</div></div>
```

**AFTER** (lines 329-336):
```html
<!-- Confirm Dialog -->
<div class="confirm-overlay" x-data
     :class="{ open: $store.app.showConfirm }"
     x-cloak
     style="display:none">
  <div class="confirm-box">
    <p x-text="$store.app.confirmMessage"></p>
    <div class="btn-row">
      <button class="btn btn-ghost" @click="$store.app.confirmResolve(false); $store.app.showConfirm = false">取消</button>
      <button class="btn btn-danger" @click="$store.app.confirmResolve(true); $store.app.showConfirm = false">确定</button>
    </div>
  </div>
</div>
```

### 1h. Update old JS: replace router, dashboard, init

**Remove from the old `<script>` block:**

- Lines 428-456: Entire tab switching logic (`tabs.forEach...`, `hashchange` listener, initial hash handler)
- Lines 468-486: Entire `loadDashboard()` function (including the `setInterval` call at line 908)
- Lines 414-426: Entire confirm logic (`_confirmResolve`, `showConfirm`, `closeConfirm`)

**Replace with** (in the old script block, keeping `esc()` and the init section):

```javascript
// ====== Init (replaced loadDashboard + setInterval) ======
const appStore = Alpine.store('app');
appStore.loadDashboard();
appStore.startPolling();

// Listen for hash changes
window.addEventListener('hashchange', () => {
  const tab = location.hash.slice(1);
  if (tab && appStore.tabNames[tab]) {
    appStore.switchTab(tab);
  }
});
if (location.hash) {
  const tab = location.hash.slice(1);
  if (appStore.tabNames[tab]) {
    appStore.switchTab(tab);
  }
}
```

---

## Phase 2: Logs Page (simple table + filter)

### Goal
Replace the logs page's JS-driven table rendering and filter with Alpine `x-for` and reactive data. This is the simplest full-page migration, serving as a warm-up for Provider/Adapter pages.

### Files changed
- `/Users/zzk/CliProject/llm-proxy/src/api/admin-ui.html`

### 2a. Logs HTML (lines 274-288)

**BEFORE** (lines 274-288):
```html
<!-- Logs -->
<div class="page" id="page-logs">
  <div class="section">
    <div class="section-header"><h3>请求 & 系统日志</h3></div>
    <div class="log-filters" id="logFilters">
      <button class="filter-btn active" data-filter="all">全部</button>
      <button class="filter-btn" data-filter="request">请求</button>
      <button class="filter-btn" data-filter="system">系统</button>
    </div>
    <div class="table-wrap" style="max-height:70vh;overflow-y:auto">
      <table><thead><tr><th style="width:160px">时间</th><th style="width:60px">类型</th><th>消息</th><th>详情</th></tr></thead>
      <tbody id="logsBody"></tbody></table>
    </div>
  </div>
</div>
```

**AFTER** (lines 274-288):
```html
<!-- Logs -->
<div class="page" id="page-logs"
     x-data="logsPage"
     :class="{ active: $store.app.currentTab === 'logs' }">
  <div class="section">
    <div class="section-header"><h3>请求 & 系统日志</h3></div>
    <div class="log-filters">
      <button class="filter-btn"
              :class="{ active: filter === 'all' }"
              @click="filter = 'all'">全部</button>
      <button class="filter-btn"
              :class="{ active: filter === 'request' }"
              @click="filter = 'request'">请求</button>
      <button class="filter-btn"
              :class="{ active: filter === 'system' }"
              @click="filter = 'system'">系统</button>
    </div>
    <div class="table-wrap" style="max-height:70vh;overflow-y:auto">
      <table><thead><tr><th style="width:160px">时间</th><th style="width:60px">类型</th><th>消息</th><th>详情</th></tr></thead>
      <tbody>
        <template x-for="log in filteredLogs" :key="log.timestamp">
          <tr>
            <td class="mono" style="font-size:11px;color:var(--text-muted)" x-text="log.timestamp.slice(11,23)"></td>
            <td><span class="badge" :class="log.type === 'request' ? 'badge-ok' : 'badge-warn'" x-text="log.type"></span></td>
            <td x-text="log.message"></td>
            <td class="mono" style="font-size:11px;color:var(--text-muted)" x-text="log.details ? JSON.stringify(log.details) : ''"></td>
          </tr>
        </template>
        <tr x-show="filteredLogs.length === 0 && allLogs.length === 0">
          <td colspan="4" class="empty">暂无日志</td>
        </tr>
        <tr x-show="filteredLogs.length === 0 && allLogs.length > 0">
          <td colspan="4" class="empty">没有匹配的日志</td>
        </tr>
      </tbody></table>
    </div>
  </div>
</div>
```

### 2b. Create `src/api/admin/components/logs.ts`

```typescript
export function logsPage() {
  return {
    allLogs: [],
    filter: 'all',

    init() {
      this.load()
    },

    get filteredLogs() {
      if (this.filter === 'all') return this.allLogs
      return this.allLogs.filter((l: any) => l.type === this.filter)
    },

    async load() {
      const data = await (Alpine as any).store('app').fetch('/admin/logs?limit=500').catch(() => null)
      this.allLogs = data?.data?.logs ?? []
    },
  }
}
```

### 2c. Remove old logs JS

**Remove from old `<script>` block:**
- Lines 489-517: `_allLogs`, `_logFilter`, `loadLogs()`, `renderLogs()`, filter button event listener

---

## Phase 3: Provider Page (most complex -- modals, CRUD, pull models, test panel)

### Goal
Migrate the entire Provider page including its modal form, dynamic model rows, pull models modal, and test panel. This is the highest-risk, highest-complexity phase.

### Files changed
- `/Users/zzk/CliProject/llm-proxy/src/api/admin-ui.html`

### 3a. Provider page HTML (lines 290-306)

**BEFORE** (lines 290-306):
```html
<!-- Providers -->
<div class="page" id="page-providers">
  <div class="section">
    <div class="section-header">
      <h3>模型供应商</h3>
      <div style="display:flex;gap:8px;align-items:center">
        <div class="search-box"><input id="providerSearch" placeholder="搜索模型供应商..." oninput="filterProviderTable()"></div>
        <button class="btn btn-primary btn-sm" onclick="openProviderForm(null)">+ 添加</button>
      </div>
    </div>
    <div class="table-wrap">
      <table><thead><tr>
        <th>名称</th><th>类型</th><th>模型数</th><th>状态</th><th>操作</th>
      </tr></thead><tbody id="providersBody"></tbody></table>
    </div>
  </div>
</div>
```

**AFTER** (lines 290-306):
```html
<!-- Providers -->
<div class="page" id="page-providers"
     x-data="providersPage"
     :class="{ active: $store.app.currentTab === 'providers' }">
  <div class="section">
    <div class="section-header">
      <h3>模型供应商</h3>
      <div style="display:flex;gap:8px;align-items:center">
        <div class="search-box"><input x-model="search" placeholder="搜索模型供应商..."></div>
        <button class="btn btn-primary btn-sm" @click="openForm(null)">+ 添加</button>
      </div>
    </div>
    <div class="table-wrap">
      <table><thead><tr>
        <th>名称</th><th>类型</th><th>模型数</th><th>状态</th><th>操作</th>
      </tr></thead><tbody>
        <template x-for="p in filteredProviders" :key="p.name">
          <tr>
            <td><strong x-text="p.name"></strong></td>
            <td><span class="mono" x-text="p.type"></span></td>
            <td class="mono" x-text="p.models?.length ?? 0"></td>
            <td><span class="badge" :class="p.available ? 'badge-ok' : 'badge-err'" x-text="p.available ? '正常' : '异常'"></span></td>
            <td>
              <button class="btn btn-sm btn-success" @click="openTestPanel(p.name)">测试</button>
              <button class="btn btn-sm btn-warning" @click="openForm(p.name)">编辑</button>
              <button class="btn btn-sm btn-danger" @click="confirmDelete(p.name)">删除</button>
            </td>
          </tr>
        </template>
        <tr x-show="filteredProviders.length === 0 && providers.length === 0">
          <td colspan="5" class="empty">暂无数据</td>
        </tr>
        <tr x-show="filteredProviders.length === 0 && providers.length > 0">
          <td colspan="5" class="empty">没有匹配的供应商</td>
        </tr>
      </tbody></table>
    </div>
  </div>
</div>
```

### 3b. Provider Modal (lines 338-358)

**BEFORE** (lines 338-358):
```html
<!-- Provider Modal -->
<div class="modal-overlay" id="providerModal"><div class="modal" style="max-height:80vh;display:flex;flex-direction:column">
  <h3 id="providerModalTitle">添加模型供应商</h3>
  <div style="flex:1;overflow-y:auto;padding-right:4px">
  <label>名称</label><input id="pName" placeholder="my-provider">
  <label>类型</label><select id="pType"><option value="openai">OpenAI</option><option value="anthropic">Anthropic</option></select>
  <label>API Key</label><input id="pApiKey" type="password" placeholder="sk-...">
  <div class="hint" id="pApiKeyHint" style="display:none">留空则保留原值</div>
  <label>API Base（可选）</label>
  <input id="pApiBase" placeholder="https://api.openai.com" style="width:100%;padding:7px 10px;font-size:13px;border:1px solid var(--border);border-radius:var(--radius);background:var(--surface);color:var(--text)">
  <label>模型列表
    <button class="btn btn-sm btn-success" onclick="openPullModels()" style="margin-left:8px">拉取远程模型</button>
  </label>
  <div class="dynamic-rows" id="pModels"></div>
  <button class="btn btn-sm btn-ghost" onclick="addModelRow('')" style="margin-top:4px;flex-shrink:0">+ 添加模型</button>
  </div>
  <div class="btn-row" style="flex-shrink:0">
    <button class="btn btn-ghost" onclick="closeModal('providerModal')">取消</button>
    <button class="btn btn-primary" id="providerSaveBtn" onclick="saveProvider()">保存</button>
  </div>
</div></div>
```

**AFTER** (lines 338-358):
```html
<!-- Provider Modal -->
<div class="modal-overlay" x-show="showModal" x-cloak style="display:none"><div class="modal" style="max-height:80vh;display:flex;flex-direction:column">
  <h3 x-text="editingName ? '编辑模型供应商' : '添加模型供应商'"></h3>
  <div style="flex:1;overflow-y:auto;padding-right:4px">
  <label>名称</label><input x-model="form.name" placeholder="my-provider">
  <label>类型</label><select x-model="form.type">
    <option value="openai">OpenAI</option>
    <option value="anthropic">Anthropic</option>
  </select>
  <label>API Key</label><input x-model="form.apiKey" type="password" placeholder="sk-...">
  <div class="hint" x-show="editingName" x-text="'留空则保留原值'" style="display:none"></div>
  <label>API Base（可选）</label>
  <input x-model="form.apiBase" placeholder="https://api.openai.com">
  <label>模型列表
    <button class="btn btn-sm btn-success" @click="openPullModels()" style="margin-left:8px">拉取远程模型</button>
  </label>
  <div class="dynamic-rows">
    <template x-for="(m, i) in form.models" :key="i">
      <div class="dynamic-row">
        <span class="pm-label">模型 ID</span>
        <input x-model="m.id" placeholder="如 gpt-4o" style="flex:1">
        <button class="btn btn-sm btn-danger btn-icon" @click="removeModelRow(i)">✕</button>
      </div>
    </template>
  </div>
  <button class="btn btn-sm btn-ghost" @click="addModelRow()" style="margin-top:4px;flex-shrink:0">+ 添加模型</button>
  </div>
  <div class="btn-row" style="flex-shrink:0">
    <button class="btn btn-ghost" @click="showModal = false">取消</button>
    <button class="btn btn-primary" @click="save()">保存</button>
  </div>
</div></div>
```

### 3c. Pull Models Modal (lines 360-369)

**BEFORE** (lines 360-369):
```html
<!-- Pull Models Modal -->
<div class="modal-overlay" id="pullModelsModal"><div class="modal" style="max-height:80vh;display:flex;flex-direction:column">
  <h3>远程模型列表</h3>
  <div id="pullModelsStatus" style="font-size:12px;color:var(--text-muted);margin-bottom:8px"></div>
  <div id="pullModelsBody" style="flex:1;overflow-y:auto;margin-bottom:12px"></div>
  <div class="btn-row">
    <button class="btn btn-ghost" onclick="closeModal('pullModelsModal')">取消</button>
    <button class="btn btn-primary" id="pullModelsImportBtn" onclick="importPullModels()">导入选中</button>
  </div>
</div></div>
```

**AFTER** (lines 360-369):
```html
<!-- Pull Models Modal -->
<div class="modal-overlay" x-show="pullModal.visible" x-cloak style="display:none"><div class="modal" style="max-height:80vh;display:flex;flex-direction:column">
  <h3>远程模型列表</h3>
  <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px">
    <span x-show="!pullModal.loading" x-text="`共 ${pullModal.models.length} 个模型，${pullModal.existing.length} 个已存在`"></span>
    <span x-show="pullModal.loading">加载中...</span>
  </div>
  <div style="flex:1;overflow-y:auto;margin-bottom:12px">
    <template x-if="!pullModal.loading && pullModal.models.length === 0">
      <div class="empty" x-text="pullModal.error || '未找到可用模型'"></div>
    </template>
    <table x-show="!pullModal.loading && pullModal.models.length > 0">
      <thead><tr><th style="width:30px"></th><th>模型 ID</th><th>来源</th></tr></thead>
      <tbody>
        <template x-for="(m, i) in pullModal.models" :key="i">
          <tr>
            <td><input type="checkbox"
                       :checked="pullModal.existing.includes(m.id) || true"
                       :disabled="pullModal.existing.includes(m.id)"></td>
            <td><span class="mono" x-text="m.id"></span></td>
            <td style="font-size:11px;color:var(--text-muted)" x-text="m.description || ''"></td>
          </tr>
        </template>
      </tbody>
    </table>
  </div>
  <div class="btn-row">
    <button class="btn btn-ghost" @click="pullModal.visible = false">取消</button>
    <button class="btn btn-primary" @click="importPullModels()" :disabled="pullModal.loading">导入选中</button>
  </div>
</div></div>
```

### 3d. Test Modal (lines 385-400)

**BEFORE** (lines 385-400):
```html
<!-- Test Panel -->
<div class="modal-overlay" id="testModal"><div class="modal" style="min-width:500px;max-width:640px">
  <h3 id="testModalTitle">测试模型</h3>
  <div style="display:flex;gap:8px;margin-bottom:14px;align-items:center">
    <strong id="testProviderName" style="font-size:13px;min-width:80px"></strong>
    <select id="testModelSelect" style="flex:1;padding:6px 8px;font-size:12px;border:1px solid var(--border);border-radius:var(--radius)"></select>
    <button class="btn btn-primary btn-sm" id="testRunBtn" onclick="runTest()" style="min-width:52px">运行</button>
  </div>
  <div id="testResults" style="max-height:360px;overflow-y:auto;display:flex;flex-direction:column;gap:6px">
    <div class="empty" style="padding:24px">点击 "运行" 测试所选模型</div>
  </div>
  <div class="btn-row">
    <button class="btn btn-ghost" onclick="clearTestResults()" style="font-size:11.5px">清除结果</button>
    <button class="btn btn-ghost" onclick="closeModal('testModal')">关闭</button>
  </div>
</div></div>
```

**AFTER** (lines 385-400):
```html
<!-- Test Panel -->
<div class="modal-overlay" x-data="testPanel" x-show="visible" x-cloak style="display:none"><div class="modal" style="min-width:500px;max-width:640px">
  <h3 x-text="'测试 — ' + providerName"></h3>
  <div style="display:flex;gap:8px;margin-bottom:14px;align-items:center">
    <strong style="font-size:13px;min-width:80px" x-text="providerName"></strong>
    <select x-model="selectedModel" style="flex:1;padding:6px 8px;font-size:12px;border:1px solid var(--border);border-radius:var(--radius)">
      <template x-for="m in models" :key="m.id">
        <option :value="m.id" x-text="m.id"></option>
      </template>
    </select>
    <button class="btn btn-primary btn-sm" @click="run()" style="min-width:52px" :disabled="running" x-text="running ? '测试中' : '运行'"></button>
  </div>
  <div style="max-height:360px;overflow-y:auto;display:flex;flex-direction:column;gap:6px">
    <template x-for="(r, i) in results" :key="i">
      <div :style="`display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:var(--radius);font-size:12.5px;background:${r.ok ? 'var(--success-bg)' : 'var(--danger-bg)'};border-left:3px solid ${r.ok ? 'var(--success)' : 'var(--danger)'}`">
        <span style="font-weight:600;min-width:140px;max-width:200px;overflow:hidden;text-overflow:ellipsis" x-text="r.model"></span>
        <span style="font-size:11px;color:var(--text-muted);min-width:60px" x-text="r.time"></span>
        <span style="flex:1" x-text="r.ok ? '✓ ' + r.latency + 'ms' : '✗ ' + (r.error || '不可达').slice(0, 80)"></span>
      </div>
    </template>
    <div class="empty" style="padding:24px" x-show="results.length === 0">点击 "运行" 测试所选模型</div>
  </div>
  <div class="btn-row">
    <button class="btn btn-ghost" @click="clear()" style="font-size:11.5px">清除结果</button>
    <button class="btn btn-ghost" @click="visible = false">关闭</button>
  </div>
</div></div>
```

### 3e. Create `src/api/admin/components/providers.ts` and `src/api/admin/components/test-panel.ts`

**`src/api/admin/components/providers.ts`**:

```typescript
export function providersPage() {
  return {
    providers: [],
    search: '',
    editingName: null as string | null,
    showModal: false,
    form: { name: '', type: 'openai', apiKey: '', apiBase: '', models: [] as any[] },
    pullModal: { visible: false, models: [] as any[], existing: [] as string[], loading: false, error: '' },

    init() {
      this.load()
    },

    get filteredProviders() {
      const q = this.search.toLowerCase()
      return q
        ? this.providers.filter((p: any) => p.name.toLowerCase().includes(q))
        : this.providers
    },

    async load() {
      const [statusData, configData] = await Promise.all([
        (Alpine as any).store('app').fetch('/admin/status/providers'),
        (Alpine as any).store('app').fetch('/admin/config'),
      ])
      const ps = statusData?.data?.providers ?? []
      const configPs = configData?.data?.providers ?? []
      this.providers = ps.map((p: any, i: number) => ({
        ...p,
        models: configPs[i]?.models ?? [],
      }))
      ;(Alpine as any).store('app').config = configData?.data
    },

    openForm(name?: string | null) {
      this.editingName = name ?? null
      this.form = { name: '', type: 'openai', apiKey: '', apiBase: '', models: [] }
      if (name) {
        const p = this.providers.find((x: any) => x.name === name)
        if (p) {
          this.form = {
            name: p.name,
            type: p.type,
            apiKey: '',
            apiBase: p.api_base || '',
            models: (p.models || []).map((m: any) => ({ ...m })),
          }
        }
      }
      if (this.form.models.length === 0) this.form.models.push({ id: '' })
      this.showModal = true
    },

    addModelRow(id?: string) {
      this.form.models.push({ id: id || '' })
    },

    removeModelRow(index: number) {
      this.form.models.splice(index, 1)
    },

    async save() {
      const { name, type, apiKey, apiBase, models } = this.form
      const validModels = models.filter((m: any) => m.id.trim()).map((m: any) => ({ id: m.id.trim() }))
      if (!name || validModels.length === 0) {
        ;(Alpine as any).store('app').toast('请填写名称和模型列表', 'error')
        return
      }
      if (!this.editingName && !apiKey) {
        ;(Alpine as any).store('app').toast('请填写 API Key', 'error')
        return
      }

      const body = { name, type, api_key: apiKey, api_base: apiBase || undefined, models: validModels }
      let res
      if (this.editingName) {
        res = await (Alpine as any).store('app').fetch(`/admin/providers/${this.editingName}`, {
          method: 'PUT', body: JSON.stringify(body),
        })
      } else {
        res = await (Alpine as any).store('app').fetch('/admin/providers', {
          method: 'POST', body: JSON.stringify(body),
        })
      }
      if (!res.success) {
        ;(Alpine as any).store('app').toast(res.error || '保存失败', 'error')
        return
      }
      ;(Alpine as any).store('app').toast(this.editingName ? '模型供应商已更新' : '模型供应商已创建', 'success')
      this.showModal = false
      this.load()
    },

    async confirmDelete(name: string) {
      const ok = await (Alpine as any).store('app').confirm(`确定删除模型供应商 "${name}" 吗？`)
      if (!ok) return
      const res = await (Alpine as any).store('app').fetch(`/admin/providers/${name}`, { method: 'DELETE' })
      if (!res.success) {
        ;(Alpine as any).store('app').toast(res.error || '删除失败', 'error')
        return
      }
      ;(Alpine as any).store('app').toast('模型供应商已删除', 'success')
      this.load()
    },

    async openPullModels() {
      const { name, type, apiKey, apiBase } = this.form
      const effectiveName = name || this.editingName
      if (!effectiveName) {
        ;(Alpine as any).store('app').toast('请先填写供应商名称', 'error')
        return
      }
      if (!apiKey && !this.editingName) {
        ;(Alpine as any).store('app').toast('请填写 API Key', 'error')
        return
      }
      this.pullModal = { visible: true, models: [], existing: [], loading: true, error: '' }

      const body: any = { type }
      if (apiKey) body.api_key = apiKey
      if (apiBase) body.api_base = apiBase

      const res = await (Alpine as any).store('app').fetch(`/admin/providers/${effectiveName}/pull-models`, {
        method: 'POST', body: JSON.stringify(body),
      }).catch(() => null)

      if (!res?.success) {
        this.pullModal = { visible: true, models: [], existing: [], loading: false, error: res?.error || '请求失败' }
        return
      }
      this.pullModal = { visible: true, models: res.data.models || [], existing: res.data.existing || [], loading: false, error: '' }
    },

    importPullModels() {
      const existingIds = new Set(this.form.models.map((m: any) => m.id))
      let added = 0
      for (const m of this.pullModal.models) {
        if (!existingIds.has(m.id)) {
          this.form.models.push({ id: m.id })
          existingIds.add(m.id)
          added++
        }
      }
      ;(Alpine as any).store('app').toast(
        `已导入 ${added} 个模型${this.pullModal.models.length - added > 0 ? `（跳过 ${this.pullModal.models.length - added} 个已存在）` : ''}`,
        'success'
      )
      this.pullModal.visible = false
    },

    openTestPanel(name: string) {
      const config = (Alpine as any).store('app').config
      const p = config?.providers?.find((x: any) => x.name === name)
      if (!p) { ;(Alpine as any).store('app').toast('供应商未找到', 'error'); return }
      window.dispatchEvent(new CustomEvent('open-test-panel', {
        detail: { providerName: name, provider: p },
      }))
    },
  }
}
```

**`src/api/admin/components/test-panel.ts`**:

```typescript
export function testPanel() {
  return {
    visible: false,
    providerName: '',
    selectedModel: '',
    models: [] as any[],
    results: [] as any[],
    running: false,

    init() {
      window.addEventListener('open-test-panel', (e: Event) => {
        const detail = (e as CustomEvent).detail
        this.providerName = detail.providerName
        this.models = detail.provider.models || []
        this.selectedModel = this.models[0]?.id || ''
        this.visible = true
      })
    },

    async run() {
      if (!this.selectedModel) { ;(Alpine as any).store('app').toast('请选择模型', 'error'); return }
      this.running = true
      const config = (Alpine as any).store('app').config
      const p = config?.providers?.find((x: any) => x.name === this.providerName)
      const res = await (Alpine as any).store('app').fetch('/admin/test-model', {
        method: 'POST',
        body: JSON.stringify({
          type: p?.type,
          api_key: p?.api_key,
          api_base: p?.api_base,
          model: this.selectedModel,
          providerName: this.providerName,
        }),
      }).catch(() => ({ success: true, data: { reachable: false, latency: 0, error: '请求失败' } }))

      this.running = false
      const d = res.data || {}
      const ok = d.reachable === true
      this.results.unshift({
        model: this.selectedModel,
        ok,
        latency: d.latency,
        error: d.error,
        time: new Date().toLocaleTimeString(),
      })
    },

    clear() {
      this.results = []
    },
  }
}
```

Note: The Test Panel is triggered via `CustomEvent('open-test-panel')` instead of being nested inside the Provider component. This keeps them as separate Alpine components while allowing cross-component communication.

### 3f. Remove old provider JS

**Remove from old `<script>` block:**
- Lines 519-554: `_allProviders`, `_cachedConfig`, `loadProviders()`, `filterProviderTable()`
- Lines 594-602: `addModelRow()`, `collectModelRows()`
- Lines 655-657: `openModal()`, `closeModal()`
- Lines 660-729: `_pullModelsData`, `openPullModels()`, `importPullModels()`
- Lines 732-790: `editingProvider`, `openProviderForm()`, `saveProvider()`, `deleteProvider()`
- Lines 849-899: `openTestPanel()`, `runTest()`, `clearTestResults()`

---

## Phase 4: Adapter Page (cascading selects, similar to Provider)

### Goal
Migrate the Adapter page with its dynamic mapping rows and cascading provider/model selects. Architecture mirrors the Provider page.

### Files changed
- `/Users/zzk/CliProject/llm-proxy/src/api/admin-ui.html`

### 4a. Adapter page HTML (lines 308-323)

**BEFORE** (lines 308-323):
```html
<!-- Adapters -->
<div class="page" id="page-adapters">
  <div class="section">
    <div class="section-header">
      <h3>工具适配器映射</h3>
      <div style="display:flex;gap:8px;align-items:center">
        <div class="search-box"><input id="adapterSearch" placeholder="搜索适配器..." oninput="filterAdapterTable()"></div>
        <button class="btn btn-primary btn-sm" onclick="openAdapterForm(null)">+ 添加</button>
      </div>
    </div>
    <div class="table-wrap" id="adaptersWrap">
      <table><thead><tr>
        <th>适配器</th><th>类型</th><th>模型映射</th><th>状态</th><th>操作</th>
      </tr></thead><tbody id="adaptersBody"></tbody></table>
    </div>
  </div>
</div>
```

**AFTER** (lines 308-323):
```html
<!-- Adapters -->
<div class="page" id="page-adapters"
     x-data="adaptersPage"
     :class="{ active: $store.app.currentTab === 'adapters' }">
  <div class="section">
    <div class="section-header">
      <h3>工具适配器映射</h3>
      <div style="display:flex;gap:8px;align-items:center">
        <div class="search-box"><input x-model="search" placeholder="搜索适配器..."></div>
        <button class="btn btn-primary btn-sm" @click="openForm(null)">+ 添加</button>
      </div>
    </div>
    <div class="table-wrap">
      <table><thead><tr>
        <th>适配器</th><th>类型</th><th>模型映射</th><th>状态</th><th>操作</th>
      </tr></thead><tbody>
        <template x-for="a in filteredAdapters" :key="a.name">
          <tr>
            <td><strong x-text="a.name"></strong></td>
            <td><span class="mono" x-text="a.type"></span></td>
            <td><div class="adapter-tags">
              <template x-for="m in a.models" :key="m.sourceModelId + m.targetModelId">
                <span class="adapter-tag" :class="{ 'adapter-tag-err': m.status !== 'ok' }"
                      x-text="m.sourceModelId + ' → ' + m.provider + '/' + m.targetModelId"></span>
              </template>
            </div></td>
            <td>
              <span class="badge"
                    :class="a.models.every(m => m.status === 'ok') ? 'badge-ok' : 'badge-err'"
                    x-text="a.models.every(m => m.status === 'ok') ? '正常' : (a.models.find(m => m.status !== 'ok')?.status || '异常')"></span>
            </td>
            <td>
              <button class="btn btn-sm btn-warning" @click="openForm(a.name)">编辑</button>
              <button class="btn btn-sm btn-danger" @click="confirmDelete(a.name)">删除</button>
            </td>
          </tr>
        </template>
        <tr x-show="filteredAdapters.length === 0 && adapters.length === 0">
          <td colspan="5" class="empty">暂无适配器</td>
        </tr>
        <tr x-show="filteredAdapters.length === 0 && adapters.length > 0">
          <td colspan="5" class="empty">没有匹配的适配器</td>
        </tr>
      </tbody></table>
    </div>
  </div>
</div>
```

### 4b. Adapter Modal (lines 371-383)

**BEFORE** (lines 371-383):
```html
<!-- Adapter Modal -->
<div class="modal-overlay" id="adapterModal"><div class="modal" style="min-width:640px;max-width:740px">
  <h3 id="adapterModalTitle">添加适配器</h3>
  <label>名称</label><input id="aName" placeholder="my-tool">
  <label>类型</label><select id="aType"><option value="openai">OpenAI</option><option value="anthropic">Anthropic</option></select>
  <label>模型映射</label>
  <div class="dynamic-rows" id="aModels"></div>
  <button class="btn btn-sm btn-ghost" onclick="addMappingRow('', '', '', _cachedConfig?.providers)" style="margin-top:4px">+ 添加映射</button>
  <div class="btn-row">
    <button class="btn btn-ghost" onclick="closeModal('adapterModal')">取消</button>
    <button class="btn btn-primary" id="adapterSaveBtn" onclick="saveAdapter()">保存</button>
  </div>
</div></div>
```

**AFTER** (lines 371-383):
```html
<!-- Adapter Modal -->
<div class="modal-overlay" x-show="showModal" x-cloak style="display:none"><div class="modal" style="min-width:640px;max-width:740px">
  <h3 x-text="editingName ? '编辑适配器' : '添加适配器'"></h3>
  <label>名称</label><input x-model="form.name" placeholder="my-tool">
  <label>类型</label><select x-model="form.type">
    <option value="openai">OpenAI</option>
    <option value="anthropic">Anthropic</option>
  </select>
  <label>模型映射</label>
  <div class="dynamic-rows">
    <template x-for="(m, i) in form.models" :key="i">
      <div class="dynamic-row">
        <span class="pm-label">适配前模型 ID</span>
        <input x-model="m.sourceModelId" placeholder="工具发出的模型名" style="flex:1">
        <span class="pm-label">供应商</span>
        <select x-model="m.provider" @change="onProviderChange(i)" style="flex:1;min-width:0">
          <option value="">-- 选择供应商 --</option>
          <template x-for="p in providers" :key="p.name">
            <option :value="p.name" x-text="p.name"></option>
          </template>
        </select>
        <span class="pm-label">适配后模型 ID</span>
        <select x-model="m.targetModelId" style="flex:2;min-width:140px">
          <option value="">-- 选择模型 --</option>
          <template x-for="mid in getProviderModels(m.provider)" :key="mid.id">
            <option :value="mid.id" x-text="mid.id"></option>
          </template>
        </select>
        <button class="btn btn-sm btn-danger btn-icon" @click="removeMappingRow(i)">✕</button>
      </div>
    </template>
  </div>
  <button class="btn btn-sm btn-ghost" @click="addMappingRow()" style="margin-top:4px">+ 添加映射</button>
  <div class="btn-row">
    <button class="btn btn-ghost" @click="showModal = false">取消</button>
    <button class="btn btn-primary" @click="save()">保存</button>
  </div>
</div></div>
```

### 4c. Create `src/api/admin/components/adapters.ts`

```typescript
export function adaptersPage() {
  return {
    adapters: [],
    search: '',
    editingName: null as string | null,
    showModal: false,
    form: { name: '', type: 'openai', models: [] as any[] },

    init() {
      this.load()
    },

    get filteredAdapters() {
      const q = this.search.toLowerCase()
      return q
        ? this.adapters.filter((a: any) => a.name.toLowerCase().includes(q))
        : this.adapters
    },

    get providers() {
      return (Alpine as any).store('app').config?.providers ?? []
    },

    getProviderModels(providerName: string) {
      const p = this.providers.find((p: any) => p.name === providerName)
      return p?.models ?? []
    },

    async load() {
      const data = await (Alpine as any).store('app').fetch('/admin/adapters').catch(() => null)
      this.adapters = data?.data?.adapters ?? []
    },

    openForm(name?: string | null) {
      this.editingName = name ?? null
      this.form = { name: '', type: 'openai', models: [] }
      if (name) {
        const a = this.adapters.find((x: any) => x.name === name)
        if (a) {
          this.form = {
            name: a.name,
            type: a.type,
            models: (a.models || []).map((m: any) => ({
              sourceModelId: m.sourceModelId,
              provider: m.provider,
              targetModelId: m.targetModelId,
            })),
          }
        }
      }
      if (this.form.models.length === 0) this.addMappingRow()
      this.showModal = true
    },

    addMappingRow() {
      this.form.models.push({ sourceModelId: '', provider: '', targetModelId: '' })
    },

    removeMappingRow(index: number) {
      this.form.models.splice(index, 1)
    },

    onProviderChange(index: number) {
      const m = this.form.models[index]
      if (m) m.targetModelId = ''
    },

    async save() {
      const { name, type, models } = this.form
      const validModels = models.filter((m: any) => m.sourceModelId.trim() && m.provider && m.targetModelId)
      if (!name || validModels.length === 0) {
        ;(Alpine as any).store('app').toast('请填写名称和模型映射', 'error')
        return
      }

      const body = { name, type, models: validModels }
      let res
      if (this.editingName) {
        res = await (Alpine as any).store('app').fetch(`/admin/adapters/${this.editingName}`, {
          method: 'PUT', body: JSON.stringify(body),
        })
      } else {
        res = await (Alpine as any).store('app').fetch('/admin/adapters', {
          method: 'POST', body: JSON.stringify(body),
        })
      }
      if (!res.success) {
        ;(Alpine as any).store('app').toast(res.error || '保存失败', 'error')
        return
      }
      ;(Alpine as any).store('app').toast(this.editingName ? '适配器已更新' : '适配器已创建', 'success')
      this.showModal = false
      this.load()
    },

    async confirmDelete(name: string) {
      const ok = await (Alpine as any).store('app').confirm(`确定删除适配器 "${name}" 吗？`)
      if (!ok) return
      const res = await (Alpine as any).store('app').fetch(`/admin/adapters/${name}`, { method: 'DELETE' })
      if (!res.success) {
        ;(Alpine as any).store('app').toast(res.error || '删除失败', 'error')
        return
      }
      ;(Alpine as any).store('app').toast('适配器已删除', 'success')
      this.load()
    },
  }
}
```

### 4d. Remove old adapter JS

**Remove from old `<script>` block:**
- Lines 557-591: `_allAdapters`, `loadAdapters()`, `filterAdapterTable()`
- Lines 614-653: `addMappingRow()`, `updateMappingModels()`, `collectMappingRows()`
- Lines 793-846: `editingAdapter`, `openAdapterForm()`, `saveAdapter()`, `deleteAdapter()`

---

## Phase 5: Cleanup

### Goal
Remove all remaining old JS code. The old `<script>` block should be reduced to only `toast()` function and `esc()` utility, plus the final init section.

### Files changed
- `/Users/zzk/CliProject/llm-proxy/src/api/admin-ui.html`

### 5a. Remove remaining globals

After Phases 1-4, the old `<script>` block (starting at line 404) will contain:
- Lines 406-412: `toast()` -- **KEEP** (needed by Alpine store's `toast` method during transition)
- Lines 904: `esc()` -- **REMOVE** (no longer needed since `x-text` auto-escapes)
- The init code at lines 907-908: Already replaced in Phase 1h

The old `<script>` block becomes essentially empty — remove it entirely.

**Remove from old script block:**
- Line 904: `function esc(s) { ... }`
- Lines 907-908: `loadDashboard()` and `setInterval(loadDashboard, 10000)`

### 5b. Final old script block = empty → DELETE

After all removals, the old script block is empty. Remove the entire `<script>...</script>` tag at lines 404-909.

The init logic is now fully in `src/api/admin/app.ts`.

### 5c. Register remaining components in app.ts

In Phase 5, `src/api/admin/app.ts` should register all components:

```typescript
import Alpine from 'alpinejs'
import { initStore } from './store.js'
import { dashboardPage } from './components/dashboard.js'
import { logsPage } from './components/logs.js'
import { providersPage } from './components/providers.js'
import { testPanel } from './components/test-panel.js'
import { adaptersPage } from './components/adapters.js'

initStore()

// Register all page components
Alpine.data('dashboardPage', dashboardPage)
Alpine.data('logsPage', logsPage)
Alpine.data('providersPage', providersPage)
Alpine.data('adaptersPage', adaptersPage)
Alpine.data('testPanel', testPanel)

;(window as any).Alpine = Alpine
Alpine.start()
```

### 5d. Final file structure estimate

```
src/api/
├── admin/
│   ├── app.ts                  # Entry <100 lines
│   ├── store.ts                # Global store ~80 lines
│   ├── types.ts                # API types ~40 lines
│   └── components/
│       ├── dashboard.ts        # ~15 lines
│       ├── logs.ts             # ~20 lines
│       ├── providers.ts        # ~110 lines
│       ├── adapters.ts         # ~90 lines
│       └── test-panel.ts       # ~50 lines
├── handlers/                   # (unchanged backend)
├── admin-ui.html               # ~650 lines (was 911)
└── server.ts                   # +10 lines for admin-app.js route
```

---

## Rollback Strategy

### Per-phase rollback
Each phase is implemented in a single commit. To roll back any phase:

```bash
git revert <commit-hash>
# or
git checkout HEAD~1 -- src/api/admin-ui.html
```

### Testing before each phase commit
1. Open `http://localhost:<adminPort>/admin` in browser
2. Navigate all 4 tabs -- verify pages render correctly
3. Test CRUD operations: create/edit/delete a provider, create/edit/delete an adapter
4. Test pull models modal
5. Test model test panel
6. Check sidebar status indicator
7. Verify hash-based routing (refresh on any tab, URL should restore the correct tab)

### Phase boundary safety
- `x-cloak` CSS must be present before any `x-show` elements appear (Phase 1 introduces the first ones)
- Alpine CDN must load before Alpine components initialize (`defer` handles this)
- Old JS functions must NOT be removed until their corresponding Alpine component is verified working
- The `esc()` function must be kept until all `innerHTML` template literals using it are removed
- `toast()` function must be kept until Phase 5 since it is used by old JS code during intermediate phases

### Known risks
1. **Loading order**: `alpine:init` event fires after Alpine CDN loads. Components registered inside `alpine:init` are guaranteed to exist. But global functions in the old script block run at load time -- the old init code at lines 907-908 must call `loadDashboard()` and `setInterval()` BEFORE the Alpine store's `startPolling()` takes over. Solution: the old init code remains first, and the Alpine store's `startPolling()` is called after page load.
2. **`x-show` vs `style="display:none"`**: Alpine CDN might not process fast enough, causing a flash. The `x-cloak` CSS plus initial `style="display:none"` provides double protection. Add `x-cloak` to all `x-show` modals.
3. **`@click` in dynamically rendered content**: Alpine handles event delegation, so `@click` on items rendered by `x-for` works correctly without `onclick` attribute escaping issues.
4. **Adapter cascading select**: When `x-for` renders mapping rows, each row's `x-model="m.provider"` is independent. The `@change="onProviderChange(i)"` handler resets `targetModelId`. This is safe because Alpine processes the change synchronously before re-rendering the target select.
