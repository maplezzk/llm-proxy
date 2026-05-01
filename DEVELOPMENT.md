# Development Guide

Welcome! This document covers the full development workflow for llm-proxy.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Local Development](#local-development)
- [Project Structure](#project-structure)
- [Testing](#testing)
- [Commit Conventions](#commit-conventions)
- [PR Workflow](#pr-workflow)
- [Release Process](#release-process)
- [CI/CD](#cicd)
- [Architecture Notes](#architecture-notes)

---

## Prerequisites

- **Node.js** >= 20
- **npm** >= 9
- **Git**

```bash
git clone https://github.com/maplezzk/llm-proxy.git
cd llm-proxy
npm install
```

---

## Local Development

**Dev mode (run with tsx):**
```bash
npm run dev
```

**Build:**
```bash
npm run build
# Runs: tsc → copy admin-ui.html → esbuild admin-app.js
```

**Type check only:**
```bash
npm run typecheck   # tsc --noEmit
```

**Clean:**
```bash
npm run clean       # rm -rf dist
```

---

## Project Structure

```
src/
  cli/commands.ts          # CLI entry (start/stop/restart/reload)
  config/                  # YAML config loading, validation, hot-reload
  api/
    server.ts              # HTTP route dispatcher (regex matching)
    admin/                 # Admin UI (Alpine.js SPA)
      components/          # dashboard/logs/providers/adapters/capture/...
    handlers/              # API handlers (CRUD/logs/token stats/capture)
  proxy/
    router.ts              # Model routing (modelName → Provider)
    translation.ts         # Protocol translation core (Anthropic↔OpenAI↔Responses)
    stream-converter.ts    # Bidirectional SSE streaming (4 converters)
    pipeline.ts            # Unified request pipeline
    provider.ts            # forwardRequest → fetch upstream
    handlers.ts            # Proxy entry (auth/parse/route/forward)
    capture.ts             # Protocol capture (ring buffer + SSE push)
  adapter/                 # Virtual adapter endpoints (/{name}/v1/...)
  status/                  # StatusTracker / TokenTracker
  log/logger.ts            # Structured logging (in-memory + file)
```

---

## Testing

**⚠️ Always run both checks before committing:**

```bash
# Recommended: one-shot
npm run typecheck && npm test

# Or use prepublishOnly (builds first, then tests)
npm run prepublishOnly
```

**Test runner: Node.js native test runner with tsx:**
```bash
npm test              # All 115 tests
npm run test:watch    # Watch mode
```

**Run a single test file:**
```bash
node --import tsx --test test/proxy/stream-converter.test.ts
```

**Test requirements:**
- All tests must pass
- New features require corresponding tests
- TypeScript compilation must be error-free

---

## Commit Conventions

```
<type>: 中文描述

[optional body]
```

**Types:**
- `feat:` - New feature
- `fix:` - Bug fix
- `chore:` - Tooling / config
- `docs:` - Documentation
- `refactor:` - Code restructuring
- `test:` - Test additions

**Examples:**
```
feat: 协议抓包工具 + thinking 流式合规
fix: OpenAI Responses API 跨协议流式转换
chore: 添加 CI 测试 + npm 自动发布 workflow
```

---

## PR Workflow

### 1. Create a feature branch

```bash
git checkout main
git pull origin main
git checkout -b feature/<description>
# or fix/<bug-description>
```

### 2. Develop and commit

```bash
# Make changes...
npm run typecheck   # Type check
npm test            # Run tests

git add .
git commit -m "feat: 功能描述"
```

### 3. Push and create PR

```bash
git push origin feature/<description>
gh pr create --title "feat: ..." --body "..."
```

### 4. PR checklist

- ✅ Branch created from latest `main`
- ✅ `npm run typecheck` passes
- ✅ `npm test` passes (all 115 tests)
- ✅ New features have tests
- ✅ Commit messages follow conventions

---

## Release Process

全自动版本管理，基于 [release-please](https://github.com/googleapis/release-please-action) + 语义化提交（Conventional Commits）。

### 如何工作

1. **合并 PR 到 main** → release-please 扫描新增 commit
2. 根据 commit 类型自动计算版本号：
   - `feat:` → minor（0.1.0 → 0.2.0）
   - `fix:` → patch（0.1.0 → 0.1.1）
   - `BREAKING CHANGE` 或 `feat!:` → major（0.1.0 → 1.0.0）
   - `chore:`, `docs:`, `test:`, `refactor:` → **不触发发布**
3. release-please 自动创建/更新一个 **Release PR**（含版本号修改 + changelog）
4. 你审核 Release PR，确认后合并到 main
5. 合并后 release-please 自动：
   - 创建 GitHub Release + git tag
   - 触发 npm publish（通过 `release.yml`）
   - 触发 macOS app 构建上传（通过 `release-app.yml`）

### 日常开发流程

```bash
# 正常开发，用 conventional commit 提交
git commit -m "feat: 新功能"
git commit -m "fix: 修 bug"

# PR 合并到 main 后，release-please 会自动处理版本号
# 你只需在 Release PR 出现后审核并合并
```

### 不触发发布

使用 `chore:` / `docs:` / `test:` / `refactor:` 类型的 commit 不会触发 release-please 创建 Release PR。

### 手动触发

在 GitHub Actions 中手动运行 `release.yml` 的 `workflow_dispatch` 也可触发发布。

---

## CI/CD

| Workflow | Trigger | Actions |
|----------|---------|---------|
| `ci.yml` | PR → main, push → main | install → typecheck → test → build |
| `release.yml` | push → main (releaes-please) | 扫描 commit，创建/更新 Release PR |
| `release.yml` (publish) | Release PR merged | release-please 创建 GitHub Release + tag，自动发布 npm |
| `release-app.yml` | Release published | 构建 macOS App，上传 DMG 到 Release，更新 Homebrew tap |

---

## Architecture Notes

### Protocol Translation

llm-proxy supports bidirectional translation across three protocols:

| Direction | Non-streaming | Streaming (SSE) |
|-----------|-------------|-----------------|
| Anthropic → OpenAI | ✅ | ✅ |
| OpenAI → Anthropic | ✅ | ✅ |
| Anthropic → OpenAI Responses | ✅ | ✅ |
| OpenAI Responses → Anthropic | ✅ | ✅ |

### Key concepts

- **Model Routing**: `modelName` → matched Provider → upstream fetch
- **Adapter Endpoints**: virtual paths (`/{adapter-name}/v1/...`) with model remapping
- **Hot Reload**: `POST /admin/config/reload` atomically swaps runtime config
- **Protocol Capture**: ring buffer recording raw request/response pairs with SSE push to admin UI
- **Thinking blocks**: SHA-256 deterministic pseudo-signatures for cross-protocol thinking preservation

### Ports

| Port | Purpose |
|------|---------|
| 9000 | Proxy API (`/v1/*`) + Admin UI (`/admin/*`) |
