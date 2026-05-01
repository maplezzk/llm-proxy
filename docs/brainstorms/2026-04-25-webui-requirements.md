---
date: 2026-04-25
topic: web-ui
---

# Web UI 管理面板

## Problem Frame
当前 llm-proxy 的配置管理和状态查看只能通过 curl/CLI 操作，缺少可视化界面。开发者需要能直观查看代理状态、编辑配置、监控 Provider 健康的 Web UI。

## Requirements

**仪表盘**
- R1. 页面自动加载，显示代理运行状态（健康检查）
- R2. 显示 Provider 总数和 Model 总数

**配置管理**
- R3. 查看当前运行时配置（Key 脱敏）
- R4. 在 YAML 编辑器中编辑配置并提交重载
- R5. 重载结果即时反馈（成功/失败+错误列表）

**Provider 状态**
- R6. 列表显示所有 Provider 的延迟、错误率、请求数、可用性

**通用**
- R7. 单 HTML 文件，零外部依赖，内嵌在代理中
- R8. 由代理在 `GET /admin/` 路由提供
- R9. 响应式设计，桌面和移动端可用
