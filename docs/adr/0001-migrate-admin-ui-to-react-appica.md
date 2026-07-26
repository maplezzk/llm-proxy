# 管理后台前端迁移到 React + Appica UI + Vite

Admin UI 从 Alpine.js + 手写 CSS + esbuild 单文件，整体迁移到 React + Appica UI（`@appica/ui-react`，基于 Base UI + Tailwind CSS v4）+ Vite 构建。目标是获得成熟组件库（无障碍、键盘交互、动效、原生 light/dark）与现代化构建体验，代价是引入 React/Tailwind 依赖、重写全部 10 个组件并调整交付结构。

- **Status**: accepted
- **Considered Options**:
  - *保持 Alpine，仅视觉重绘*（拒绝：无法复用 Appica 组件与其无障碍/动效能力，Appica 为 React-only）
  - *保持 esbuild 单文件而非 Vite*（拒绝：用户选择 Vite；React + Tailwind 工具链下 Vite dev/HMR 体验显著更好，接受交付结构调整成本）
- **Consequences**:
  - server 需改为 serve Vite 构建产物（`dist/admin` 下的 html + assets），npm `files` 与 macOS app build 需同步适配。
  - 主题采用 Appica 默认（含 light/dark），与旧 UI 视觉差异明显——属用户明确接受的取舍。
  - jsoneditor（CDN）与图表库（recharts）以 React 组件封装保留/替换，详见 grill 记录。
