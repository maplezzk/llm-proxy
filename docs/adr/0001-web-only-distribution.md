# 采用纯 Web 分发

llm-proxy 仅交付 Node.js CLI 与浏览器 Admin UI。移除 macOS Swift App、DMG/Homebrew 发布链路、更新工具、资源、测试和面向用户的文档。这是有意的破坏性产品简化：它在保留 CLI 服务生命周期和 `/admin/` 管理入口的同时，去除原生桌面端的维护与发布成本。