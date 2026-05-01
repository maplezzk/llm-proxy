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

Automated via GitHub Actions (OIDC Trusted Publisher).

### Version management

```bash
npm version patch   # 0.1.0 → 0.1.1 (bug fix)
npm version minor   # 0.1.0 → 0.2.0 (new feature)
npm version major   # 0.1.0 → 1.0.0 (breaking change)

git push && git push --tags
```

### How it works

1. PR merged to `main`
2. `release.yml` detects version change in `package.json`
3. If changed → publishes to npm (`@maplezzk/llm-proxy`) + creates GitHub Release
4. If unchanged → skipped

### Skip release

Add `[skip release]` to PR title:
```
[skip release] chore: 更新文档
```

---

## CI/CD

| Workflow | Trigger | Actions |
|----------|---------|---------|
| `ci.yml` | PR → main, push → main | install → typecheck → test → build |
| `release.yml` | PR merged to main | test → build → version check → npm publish + GitHub Release |

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
