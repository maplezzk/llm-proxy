---
date: 2026-04-26
topic: admin-ui-alpine-migration
---

# 需求文档: Admin UI Alpine.js 渐进式重构

## 背景

### 现状痛点

`src/api/admin-ui.html` (911 行) 是一个纯 Vanilla JS SPA，当前存在以下问题:

1. **全局变量污染**: 8 个模块级全局变量 (`_confirmResolve` L415, `_allLogs` L489, `_logFilter` L490, `_allProviders` L520, `_cachedConfig` L521, `_allAdapters` L557, `_pullModelsData` L660, `editingProvider` L732, `editingAdapter` L793) 分散在不同的函数之间，数据流不透明
2. **手动 DOM 操作**: 所有页面渲染通过 `document.getElementById().innerHTML = ...` 拼接模板字符串 (见 L480-485, L500-507, L541-553, L571-591 等)，无响应式绑定
3. **表单状态管理混乱**: 表单打开时手动 setValue / reset (L737-755, L797-815)，容易遗漏字段
4. **Modal 打开/关闭**: 通过 `classList.add('open')` / `classList.remove('open')` 手动控制 (L656-657)
5. **搜索过滤**: 通过 `oninput` 事件调用 `filterProviderTable()` / `filterAdapterTable()`，每次重新拼 HTML
6. **动态行管理**: `addModelRow()` (L596) 和 `addMappingRow()` (L614) 直接 `createElement` + `appendChild`，无数据驱动
7. **Tab 切换**: 手动操作 `classList` 并维护 `pageTitles` 映射 (L428-456)
8. **测试结果**: `runTest()` (L863) 直接 `appendChild` 到结果容器，需要手动移除 empty 占位

### 目标

- 消除全局变量，用 `Alpine.store()` 集中管理状态
- 用 `x-data` + `x-text` / `x-html` / `x-show` / `x-for` 替换手动 DOM 操作
- 保持单一 HTML 文件，零构建工具
- 渐进迁移: 先重构 Provider 表单（最复杂），再逐步迁移其他模块
- 每个阶段完成后功能不变

## 技术决策

1. **Alpine.js CDN 引入 (零构建)**
   - 引入 `<script defer src="https://cdn.jsdelivr.net/npm/alpinejs@3.x.x/dist/cdn.min.js"></script>`
   - 完全在单 HTML 文件中完成，不拆分前端代码到独立项目
   - CSS 不动，保持现有样式系统

2. **hash-based 路由保持**
   - 当前使用 `location.hash` 做路由 (L443-456)，Alpine 阶段不动
   - 仅将路由逻辑移到 Alpine 的 store 或 component 中

3. **渐进迁移策略**
   - 阶段 0: 基础框架 (Alpine CDN + store 定义 + `api()` 提取)
   - 阶段 1: Provider 表单 (modal + CRUD + 搜索) -- 最复杂
   - 阶段 2: Adapter 表单
   - 阶段 3: Logs 页面
   - 阶段 4: Dashboard 页面
   - 阶段 5: 清理删除旧代码

4. **不改后端 API 契约**
   - 所有 Alpine.store().api() 复用现有 fetch 逻辑
   - 返回格式不变

## 迁移步骤

### 阶段 0: 准备工作 (框架独立)

**目标**: 引入 Alpine.js，建立全局 store 骨架，不改任何现有 JS。

**具体动作**:
1. 在 `</head>` 前插入 Alpine CDN script
2. 新建 `<script>` 块（在现有 `<script>` 之前），定义 `Alpine.store('app', { ... })`
3. 将 `api()` 函数 (L459-465) 移入 store 的 `methods` 中，同时保留旧函数
4. 定义统一错误处理: `store.toast()`, `store.confirm()` 保留全局函数签名不变
5. 定义 `src/shared/types.ts` 中的 API 响应类型 (见下方"关键接口"章节)

**不改变区域**: 现有 L404-L909 的 JS 代码完全不动

**验证方法**: 页面加载后 Alpine 初始化不报错，所有现有功能正常

**类型定义** (应新建 `src/shared/types.ts`):

```typescript
// API 通用响应
interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
}

// Provider
interface ProviderModel { id: string }
interface ProviderConfig {
  name: string;
  type: string;
  api_key?: string;
  api_base?: string;
  models: ProviderModel[];
}
interface ProviderStatus extends ProviderConfig {
  available: boolean;
}

// Adapter
interface AdapterMapping {
  sourceModelId: string;
  provider: string;
  targetModelId: string;
  status?: 'ok' | 'error';
}
interface AdapterConfig {
  name: string;
  type: string;
  models: AdapterMapping[];
}

// Config
interface AppConfig {
  providers: ProviderConfig[];
  adapters: AdapterConfig[];
}

// Log
interface LogEntry {
  timestamp: string;
  type: 'request' | 'system';
  message: string;
  details?: any;
}

// Health
interface HealthResponse {
  success: boolean;
  // ...
}
```

### 阶段 1: Provider 表单 (最复杂页面)

**涉及区域**: L291-306 (HTML), L338-369 (modals), L519-602, L655-790 (JS)

此阶段是迁移的核心验证，因为 Provider 涉及:
- 创建/编辑模态框 (L338-358)
- 动态模型行列表 (L596-602)
- 远程拉取模型 (L660-729)
- CRUD 三个操作 (L734-790)
- 搜索过滤 (L535-554)
- 表格渲染 (L541-553)

**具体拆解**:

#### 1a. 用 Alpine component 包裹 Provider 模态框

将 L291-306 和 L338-358 改为:

```html
<div class="page" id="page-providers" x-data="providersPage">
  ...
</div>
```

`x-data="providersPage"` 返回一个对象包含:
- `search: ''` — 搜索关键字
- `providers: []` — 供应商列表
- `editingName: null` — 编辑模式下的名称
- `form: { name, type, apiKey, apiBase, models: [] }` — 表单数据
- `showModal: false`
- `pullModels: { visible: false, models: [], existing: Set, loading: false }`
- `loadProviders()` — 调用 API 填充 `providers`
- `filteredProviders` — 计算属性 (按 search 过滤)
- `openForm(name?)` — 初始化 form
- `saveProvider()`
- `deleteProvider(name)`
- `addModelRow(id?)` — 向 form.models 添加
- `removeModelRow(index)` — 按索引删除
- `collectModels()` — 收集 form.models
- `openPullModels()` / `importPullModels()`

#### 1b. 替换 JS 操作:

| 旧代码 | Alpine 替代 |
|--------|-------------|
| `_allProviders` (L520) | `providersPage.providers` |
| `editingProvider` (L732) | `providersPage.editingName` |
| `filterProviderTable()` (L535) | `x-for` 遍历 `filteredProviders` |
| `document.getElementById('providersBody').innerHTML` | `<template x-for="p in filteredProviders">...` |
| `addModelRow()` (L596) | `form.models.push({ id })` + `x-for` 渲染 |
| `collectModelRows()` (L604) | 直接用 `form.models` |
| `openPullModels()` (L662) | `pullModels.visible = true` |
| `importPullModels()` (L704) | 循环 `form.models.push(...)` |
| `openProviderForm()` (L734) | `form = { name, type, apiKey, ... }` |
| `saveProvider()` (L760) | `methods.saveProvider()` |
| `deleteProvider()` (L783) | `methods.deleteProvider()` |
| `openModal` / `closeModal` (L656) | `x-show` 绑定到布尔值 |

**L347**: API Base input 使用内联 style (L347)，迁移后改为 class 引用

**L349-352**: "拉取远程模型" 按钮 + 模型列表 + "添加模型" 按钮 — 全部由 Alpine 控制:
- `x-show="pullModels.visible"` 控制 modal
- `<template x-for="(m, i) in form.models">` 渲染模型行
- 删除按钮 `@click="form.models.splice(i, 1)"`

**L301-304**: 表格 thead/tbody 替换为:
```html
<tbody>
  <template x-for="p in filteredProviders" :key="p.name">
    <tr>
      <td x-text="p.name"></td>
      <td x-text="p.type"></td>
      <td x-text="p.models?.length ?? 0"></td>
      <td><span class="badge" :class="p.available ? 'badge-ok' : 'badge-err'" x-text="p.available ? '正常' : '异常'"></span></td>
      <td>
        <button @click="openTestPanel(p.name)">测试</button>
        <button @click="openForm(p.name)">编辑</button>
        <button @click="deleteProvider(p.name)">删除</button>
      </td>
    </tr>
  </template>
</tbody>
```

**L296**: 搜索框替换:
```html
<input x-model="search" placeholder="搜索模型供应商...">
```

#### 1c. 保留现有函数作为阶段 1 的 fallback

阶段 1 迁移后，若 Alpine 未加载 (CDN 失败)，不会报错 — 但这个风险可以接受，因为 Alpine CDN 会同步阻塞渲染。

#### 1d. 测试面板也被 Provider 列表触发

`openTestPanel` (L849-861) 和 `runTest()` (L863-895) — 虽然属于 "测试" 功能，但它和 Provider 相关。决定: 留在阶段 1 一起迁移，或用独立的 `x-data="testPanel"`:

```html
<div class="modal-overlay" id="testModal" x-data="testPanel" x-show="visible">
```

### 阶段 2: Adapter 表单

**涉及区域**: L309-323 (HTML), L371-383 (modals), L557-653, L793-846 (JS)

**相似架构**:
- `x-data="adaptersPage"` 包裹 #page-adapters
- `adapters: []`, `search: ''`, `editingName: null`, `form: { name, type, models: [] }`
- 搜索过滤同 Provider 模式
- 动态 mapping 行同 Provider 模型行，但更复杂 (3 个字段 + 级联 select)

#### 2a. 动态 mapping 行的级联 select

当前 `addMappingRow()` (L614-626) + `updateMappingModels()` (L628-642):
- 选择 provider 后，target model select 动态更新为对应 provider 的 models
- 在 Alpine 中: `x-model="m.provider"` + `@change="updateModels(m)"`

Alpine 的 `x-model` 配合 `@change` 可以优雅处理:
```html
<select x-model="m.provider" @change="onProviderChange($event, m)">
  <template x-for="p in providers" :key="p.name">
    <option :value="p.name" x-text="p.name"></option>
  </template>
</select>
<select x-model="m.targetModelId">
  <template x-for="mid in getProviderModels(m.provider)" :key="mid.id">
    <option :value="mid.id" x-text="mid.id"></option>
  </template>
</select>
```

这里 `getProviderModels` 是一个计算方法: `providers.find(p => p.name === providerName)?.models || []`

#### 2b. 合并 _cachedConfig 到全局 store

`_cachedConfig` (L521) 在 Provider 和 Adapter 之间共享。Alpine 方案:
- `Alpine.store('app', { config: null, ... })`
- Provider 和 Adapter 组件都从 `Alpine.store('app').config` 读取

### 阶段 3: Logs 页面

**涉及区域**: L275-288 (HTML), L489-517 (JS)

**最简迁移**:
- `x-data="logsPage"`, `allLogs`, `filter`
- `x-for` 渲染日志行
- `@click` 处理 filter 切换
- `loadLogs()` 在 tab 激活时调用

### 阶段 4: Dashboard 页面

**涉及区域**: L270-272 (HTML), L468-486 (JS)

- `x-data="dashboardPage"` 包裹 #page-dashboard
- 直接使用 `Alpine.store('app').health` 和 `Alpine.store('app').config`
- `x-for` 渲染 stat 卡片
- 10s 定时器由 store 统一管理

### 阶段 5: 清理

**目标**: 删除所有不再需要的全局函数和变量

1. 删除所有 `_allProviders`, `_allLogs`, `_cachedConfig` 等全局变量
2. 删除 `loadProviders()`, `loadLogs()`, `loadAdapters()` 等旧函数
3. 保留 `esc()` 作为 utility（或移入 store）
4. 删除 L428-456 的 tab 切换逻辑，改为 Alpine 的 `x-data="router"`
5. 删除 L656-657 的 modal helpers
6. 删除 L904 的 `esc()` — 迁移到 store 或内联在模板中（Alpine 默认不转义 HTML，但 `x-text` 已转义）

## 组件拆解

| 组件 (Alpine x-data) | 管理的数据源 | 对应旧代码区域 | 页面区域 | 复杂度 |
|---------------------|-------------|---------------|---------|--------|
| `router` (全局 store) | `currentTab`, `tabs` | L428-456 | — | 低 |
| `app` (Alpine.store) | `config`, `health`, `toast()`, `confirm()`, `api()` | L406-427, L459-465, L907-908 | — | 中 |
| `dashboardPage` | `stats` 从 app store 派生 | L468-486 | L270-272 | 低 |
| `logsPage` | `allLogs`, `filter`, `filteredLogs` | L489-517 | L275-288 | 低 |
| `providersPage` | `providers`, `search`, `filteredProviders`, `form`, `pullModels`, `showModal`, `editingName` | L519-602, L660-790 | L291-306, L338-369, L385-400 | **高** |
| `adaptersPage` | `adapters`, `search`, `filteredAdapters`, `form`, `showModal`, `editingName` | L557-653, L793-846 | L309-323, L371-383 | **中-高** |
| `testPanel` | `providerName`, `models`, `testResults`, `selectedModel`, `running` | L849-899 | L385-400 | 低-中 |

总计: 6 个 x-data 组件 + 2 个 Alpine.store

## 状态管理方案

### Alpine.store('app') 设计

```javascript
Alpine.store('app', {
  // ===== 共享数据 =====
  config: null,          // GET /admin/config 的结果
  health: null,          // GET /admin/health 的结果
  status: 'loading',     // 'loading' | 'running' | 'offline'

  // ===== 共享方法 =====
  async fetch(path, opts) {
    const r = await fetch('/admin' + path, {
      ...opts,
      headers: { 'Content-Type': 'application/json', ...opts?.headers },
    });
    return r.json();
  },

  toast(message, type = 'info') {
    const el = document.createElement('div');
    el.className = 'toast toast-' + type;
    el.textContent = message;
    document.getElementById('toastContainer').appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transition = 'opacity 0.3s';
      setTimeout(() => el.remove(), 300);
    }, 3000);
  },

  async confirm(msg) {
    return new Promise(resolve => {
      // 使用 Alpine 管理的 confirm 组件
      this.confirmMessage = msg;
      this.confirmResolve = resolve;
      this.showConfirm = true;
    });
  },

  confirmResolve: null,
  showConfirm: false,
  confirmMessage: '',

  // ===== 路由 =====
  currentTab: 'dashboard',
  tabs: ['dashboard', 'logs', 'providers', 'adapters'],
  tabNames: {
    dashboard: '仪表盘',
    logs: '日志',
    providers: '模型供应商',
    adapters: '适配器',
  },

  switchTab(tab) {
    this.currentTab = tab;
    location.hash = '#' + tab;
  },

  // ===== 定时器 =====
  _dashboardInterval: null,

  startPolling() {
    this._dashboardInterval = setInterval(() => {
      this.loadDashboard();
    }, 10000);
  },

  stopPolling() {
    if (this._dashboardInterval) {
      clearInterval(this._dashboardInterval);
      this._dashboardInterval = null;
    }
  },

  async loadDashboard() {
    const [health, config] = await Promise.all([
      this.fetch('/health').catch(() => null),
      this.fetch('/config').catch(() => null),
    ]);
    this.health = health;
    this.config = config?.data ?? null;
    this.status = health?.success ? 'running' : 'offline';
  },
});
```

### 各组件独立状态

```javascript
// 仪表盘 - 纯派生，不需要自己的 store
// 直接从 Alpine.store('app') 的 health/config 派生 stat 卡片

// Logs 页面
function logsPage() {
  return {
    allLogs: [],
    filter: 'all',
    get filteredLogs() {
      return this.filter === 'all'
        ? this.allLogs
        : this.allLogs.filter(l => l.type === this.filter);
    },
    async load() {
      const data = await Alpine.store('app').fetch('/logs?limit=500');
      this.allLogs = data?.data?.logs ?? [];
    },
    setFilter(f) {
      this.filter = f;
    },
  };
}

// Providers 页面
function providersPage() {
  return {
    providers: [],
    search: '',
    editingName: null,
    showModal: false,
    showPullModal: false,
    pullModels: [],
    pullExisting: [],
    pullLoading: false,
    form: { name: '', type: 'openai', apiKey: '', apiBase: '', models: [] },

    init() {
      this.load();
    },

    get filteredProviders() {
      const q = this.search.toLowerCase();
      return q
        ? this.providers.filter(p => p.name.toLowerCase().includes(q))
        : this.providers;
    },

    async load() {
      const [statusData, configData] = await Promise.all([
        Alpine.store('app').fetch('/status/providers'),
        Alpine.store('app').fetch('/config'),
      ]);
      const ps = statusData?.data?.providers ?? [];
      const configPs = configData?.data?.providers ?? [];
      this.providers = ps.map((p, i) => ({
        ...p,
        models: configPs[i]?.models ?? [],
      }));
      Alpine.store('app').config = configData?.data;
    },

    openForm(name) {
      this.editingName = name ?? null;
      this.form = { name: '', type: 'openai', apiKey: '', apiBase: '', models: [] };
      if (name) {
        const p = this.providers.find(x => x.name === name);
        if (p) {
          this.form = {
            name: p.name,
            type: p.type,
            apiKey: '',
            apiBase: p.api_base || '',
            models: (p.models || []).map(m => ({ ...m })),
          };
        }
      }
      if (this.form.models.length === 0) this.form.models.push({ id: '' });
      this.showModal = true;
    },

    addModelRow(id) {
      this.form.models.push({ id: id || '' });
    },

    removeModelRow(index) {
      this.form.models.splice(index, 1);
    },

    async save() {
      const { name, type, apiKey, apiBase, models } = this.form;
      const validModels = models.filter(m => m.id.trim()).map(m => ({ id: m.id.trim() }));
      if (!name || validModels.length === 0) {
        Alpine.store('app').toast('请填写名称和模型列表', 'error');
        return;
      }
      if (!this.editingName && !apiKey) {
        Alpine.store('app').toast('请填写 API Key', 'error');
        return;
      }

      const body = { name, type, api_key: apiKey, api_base: apiBase || undefined, models: validModels };
      let res;
      if (this.editingName) {
        res = await Alpine.store('app').fetch(`/providers/${this.editingName}`, {
          method: 'PUT', body: JSON.stringify(body),
        });
      } else {
        res = await Alpine.store('app').fetch('/providers', {
          method: 'POST', body: JSON.stringify(body),
        });
      }
      if (!res.success) {
        Alpine.store('app').toast(res.error || '保存失败', 'error');
        return;
      }
      Alpine.store('app').toast(this.editingName ? '模型供应商已更新' : '模型供应商已创建', 'success');
      this.showModal = false;
      this.load();
    },

    async confirmDelete(name) {
      const ok = await Alpine.store('app').confirm(`确定删除模型供应商 "${name}" 吗？`);
      if (!ok) return;
      const res = await Alpine.store('app').fetch(`/providers/${name}`, { method: 'DELETE' });
      if (!res.success) {
        Alpine.store('app').toast(res.error || '删除失败', 'error');
        return;
      }
      Alpine.store('app').toast('模型供应商已删除', 'success');
      this.load();
    },

    // Pull models 相关
    async openPullModels() {
      const { name, type, apiKey, apiBase } = this.form;
      const effectiveName = name || this.editingName;
      if (!effectiveName) {
        Alpine.store('app').toast('请先填写供应商名称', 'error');
        return;
      }
      if (!apiKey && !this.editingName) {
        Alpine.store('app').toast('请填写 API Key', 'error');
        return;
      }
      this.pullLoading = true;
      this.showPullModal = true;

      const body = { type };
      if (apiKey) body.api_key = apiKey;
      if (apiBase) body.api_base = apiBase;

      const res = await Alpine.store('app').fetch(`/providers/${effectiveName}/pull-models`, {
        method: 'POST', body: JSON.stringify(body),
      }).catch(() => null);

      this.pullLoading = false;
      if (!res?.success) {
        this.pullModels = [];
        this.pullExisting = [];
        return;
      }
      this.pullModels = res.data.models || [];
      this.pullExisting = res.data.existing || [];
    },

    importPullModels() {
      const existingIds = new Set(this.form.models.map(m => m.id));
      let added = 0;
      for (const m of this.pullModels) {
        if (!existingIds.has(m.id)) {
          this.form.models.push({ id: m.id });
          existingIds.add(m.id);
          added++;
        }
      }
      const skipCount = this.pullModels.length - added;
      Alpine.store('app').toast(`已导入 ${added} 个模型${skipCount > 0 ? `（跳过 ${skipCount} 个已存在）` : ''}`, 'success');
      this.showPullModal = false;
    },
  };
}

// Adapters 页面
function adaptersPage() {
  return {
    adapters: [],
    search: '',
    editingName: null,
    showModal: false,
    form: { name: '', type: 'openai', models: [] },

    // ... Provider 的相似模式

    get filteredAdapters() { /* ... */ },

    getProviderModels(providerName) {
      const config = Alpine.store('app').config;
      return config?.providers?.find(p => p.name === providerName)?.models ?? [];
    },

    async load() {
      const data = await Alpine.store('app').fetch('/adapters');
      this.adapters = data?.data?.adapters ?? [];
    },

    openForm(name) { /* 同 Provider 模式 */ },
    addMappingRow() { /* form.models.push 带 3 个字段 */ },
    removeMappingRow(index) { /* form.models.splice */ },
    async save() { /* PUT/POST /adapters */ },
    async confirmDelete(name) { /* DELETE /adapters */ },
  };
}

// 测试面板
function testPanel() {
  return {
    visible: false,
    providerName: '',
    selectedModel: '',
    models: [],
    results: [],
    running: false,

    open(name) {
      const config = Alpine.store('app').config;
      const p = config?.providers?.find(x => x.name === name);
      if (!p) { Alpine.store('app').toast('供应商未找到', 'error'); return; }
      this.providerName = name;
      this.models = p.models || [];
      this.selectedModel = this.models[0]?.id || '';
      this.visible = true;
    },

    async run() {
      if (!this.selectedModel) { Alpine.store('app').toast('请选择模型', 'error'); return; }
      this.running = true;
      const config = Alpine.store('app').config;
      const p = config?.providers?.find(x => x.name === this.providerName);
      const res = await Alpine.store('app').fetch('/test-model', {
        method: 'POST',
        body: JSON.stringify({
          type: p?.type,
          api_key: p?.api_key,
          api_base: p?.api_base,
          model: this.selectedModel,
          providerName: this.providerName,
        }),
      });
      this.running = false;
      // 从 res 提取结果
      this.addResult(this.selectedModel, res);
    },

    addResult(model, res) {
      const d = res?.data || {};
      const ok = d.reachable === true;
      this.results.unshift({ model, ok, latency: d.latency, error: d.error, time: new Date().toLocaleTimeString() });
    },

    clear() {
      this.results = [];
    },
  };
}
```

## Confirm 组件 (替换全局)

当前 confirm 使用 `_confirmResolve` 闭包 (L415-426)。Alpine 方案:

```html
<!-- Confirm Dialog -->
<div x-data x-show="$store.app.showConfirm" class="confirm-overlay" :class="{ open: $store.app.showConfirm }"
     x-cloak style="display:none">
  <div class="confirm-box">
    <p x-text="$store.app.confirmMessage"></p>
    <div class="btn-row">
      <button class="btn btn-ghost" @click="$store.app.confirmResolve(false); $store.app.showConfirm = false">取消</button>
      <button class="btn btn-danger" @click="$store.app.confirmResolve(true); $store.app.showConfirm = false">确定</button>
    </div>
  </div>
</div>
```

注意: `x-cloak` 需要添加对应 CSS: `[x-cloak] { display: none !important; }`

## 关键接口

### API 端点一览

所有端点基于 `/admin` 前缀。

| 方法 | 路径 | 用途 | 在旧代码中的行 | 数据类型 |
|------|------|------|--------------|---------|
| GET | `/admin/health` | 健康检查 | L470 | `{ success: boolean }` |
| GET | `/admin/config` | 获取完整配置 | L471, L526, L744, L803 | `{ success: boolean, data: AppConfig }` |
| GET | `/admin/logs?limit=500` | 获取日志 | L493 | `{ success, data: { logs: LogEntry[] } }` |
| GET | `/admin/status/providers` | 获取供应商状态 | L525 | `{ success, data: { providers: ProviderStatus[] } }` |
| GET | `/admin/adapters` | 获取适配器列表 | L560, L806 | `{ success, data: { adapters: AdapterConfig[] } }` |
| POST | `/admin/providers` | 创建供应商 | L775 | Request: ProviderConfig |
| PUT | `/admin/providers/:name` | 更新供应商 | L771 | Request: ProviderConfig |
| DELETE | `/admin/providers/:name` | 删除供应商 | L786 | — |
| POST | `/admin/providers/:name/pull-models` | 拉取远程模型 | L682 | Request: `{ type, api_key?, api_base? }`, Response: `{ success, data: { models: ProviderModel[], existing: string[] } }` |
| POST | `/admin/adapters` | 创建适配器 | L831 | Request: AdapterConfig |
| PUT | `/admin/adapters/:name` | 更新适配器 | L827 | Request: AdapterConfig |
| DELETE | `/admin/adapters/:name` | 删除适配器 | L843 | — |
| POST | `/admin/test-model` | 测试模型连通性 | L874 | Request: `{ type, api_key?, api_base?, model, providerName }`, Response: `{ success, data: { reachable: boolean, latency: number, error?: string } }` |

### 接口变化

- **无变化**: 所有接口保持现有签名
- **仅前端重构**: 不改变任何 API 路由、请求体格式、响应格式

## 阶段边界与回滚策略

### 阶段边界规则

1. **任何阶段不允许同时改动 HTML 模板和 JS 逻辑**: 要么先用 Alpine 改写 HTML (x-data, x-for, x-text)，要么先保留。实际推荐一起改——对一个页面，一次性替换其 HTML 模板和对应 JS 函数
2. **一个阶段只处理一个 page 组件**: Provider 阶段不碰 Adapter 代码
3. **全局状态提取后，Alpine.store('app') 在阶段 0 完成**

### 风险点

| 风险 | 缓解措施 |
|------|---------|
| Alpine CDN 加载失败 | 页面退化到完全空白。备选: fallback 到全局函数 + 在 window 上检查 Alpine 是否存在 |
| `x-html` 使用不当导致 XSS | Provider/Adapter 名称经过用户输入，`x-text` 已转义。动态行中用户输入仅显示在 input 中，安全 |
| 级联 select 性能 | adapter 的 provider 变化触发 target model 刷新。每次重新计算 getProviderModels() — 如果 provider 少 (<50)，性能无问题 |
| 搜索过滤延迟 | `x-model` 绑定到 `search`，每次 keystroke 触发 re-render。当前 provider 和 adapter 数量 < 100，性能不受影响 |

### 回滚

- 每阶段迁移后，用 `git stash` 反向验证
- 保留旧 JS 代码直到阶段 5，期间随时可以删除 Alpine 引入，恢复原始全局函数

## 行号参考总表

所有行号基于 `src/api/admin-ui.html` (当前 911 行)。

| 文件区域 | 行号 | 迁移阶段 | 处理方式 |
|---------|------|---------|---------|
| Toast | L36-45, L402, L406-412 | 0 | 移入 store.app.toast |
| Confirm | L47-52, L329-336, L415-426 | 0 | 移入 store + Alpine template |
| Sidebar | L244-260 | 0 | 添加 `x-data` 绑定 tab/status |
| Topbar | L263-266 | 0 | 添加 `x-text` 绑定 title |
| Tab switch JS | L428-456 | 0 | 移入 store.switchTab |
| API helper | L459-465 | 0 | 移入 store.fetch |
| Dashboard HTML | L270-272 | 4 | 添加 x-data + x-for stat 卡片 |
| Dashboard JS | L468-486 | 4 | 替换为 Alpine 组件 |
| Logs HTML | L275-288 | 3 | x-for logs + @click filters |
| Logs JS | L489-517 | 3 | 替换为 logsPage 组件 |
| Providers HTML | L291-306 | 1 | x-for table + x-model search |
| Provider modal | L338-358 | 1 | x-show + x-model form |
| Pull models modal | L360-369 | 1 | x-show + x-for |
| Providers JS (表格+CRUD) | L519-602 | 1 | 替换为 providersPage |
| Providers JS (modal+CRUD) | L655-790 | 1 | 替换为 providersPage 方法 |
| Adapters HTML | L309-323 | 2 | x-for table + x-model search |
| Adapter modal | L371-383 | 2 | x-show + x-model form |
| Adapters JS | L557-653, L793-846 | 2 | 替换为 adaptersPage |
| Test modal | L385-400 | 1 | 跟随 Provider 迁移 |
| Test JS | L849-899 | 1 | 替换为 testPanel 组件 |
| esc() | L904 | 5 | Alpine x-text 已内置转义 |
| Init | L907-908 | 0 | 移入 store.startPolling |
| Styles | L7-241 | — | 完全不改动 |
| x-cloak CSS (新增) | — | 0 | 新增 `[x-cloak]{display:none!important}` |

## 最终文件结构预期

阶段 5 完成后, `src/api/admin-ui.html` 的总体布局:

```
<head>
  <style> /* 不变 */ </style>
  <script defer src="alpinejs CDN"></script>
</head>
<body>
  <!-- Sidebar: x-data 绑定 app store -->
  <!-- Topbar: x-text 绑定 title + count -->
  <!-- Content: 4 pages, each with x-data -->
    <!-- Dashboard (dashboardPage) -->
    <!-- Logs (logsPage) -->
    <!-- Providers (providersPage) -->
    <!-- Adapters (adaptersPage) -->
  <!-- Confirm (Alpine template) -->
  <!-- Toast container (不变) -->
  <!-- Modals (由对应 page 的 x-show 控制) -->
  <script>
    // Alpine.store('app', { ... }) -- 约 60 lines
    // function dashboardPage() { ... } -- 约 20 lines
    // function logsPage() { ... } -- 约 30 lines
    // function providersPage() { ... } -- 约 120 lines
    // function adaptersPage() { ... } -- 约 100 lines
    // function testPanel() { ... } -- 约 40 lines
    // Alpine.start() -- 不需要，defer CDN 自动启动
  </script>
</body>
```

预估迁移后 JS 总量: 350-400 行 (vs 当前 ~500 行 JS)，加上 HTML 中分散的 Alpine 指令，整体文件可能从 911 行减少到 700-750 行。

## 命名约定

| 领域 | 命名规则 | 示例 |
|------|---------|------|
| Alpine store 名 | 全小写驼峰 | `Alpine.store('app')` |
| Alpine component 函数 | 小写驼峰，描述用途 | `providersPage`, `logsPage`, `testPanel` |
| 表单字段 | 小写驼峰，无下划线 | `form.apiKey`, `form.apiBase` |
| API 数据字段 | 保持后端 snake_case | `res.data.models[i].id` |
| x-data 数据 | 不加 `_` 前缀 | 用 `providers` 而非 `_allProviders` |
| 组件内部方法 | 小写驼峰 | `load()`, `openForm()`, `save()` |
