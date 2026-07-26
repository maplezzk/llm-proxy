import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { viteSingleFile } from 'vite-plugin-singlefile'
import { copyFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    viteSingleFile(),
    {
      // 单文件构建产物默认名为 index.html，这里复制为 admin-ui.html，
      // 以匹配 server.ts 交付契约（dist/api/admin-ui.html）。
      name: 'emit-admin-ui-html',
      closeBundle() {
        const distDir = join(__dirname, 'dist')
        const src = join(distDir, 'index.html')
        const dest = join(distDir, 'admin-ui.html')
        if (existsSync(src)) copyFileSync(src, dest)
      },
    },
  ],
  build: {
    outDir: 'dist',
  },
  server: {
    host: '127.0.0.1',
    port: Number(process.env.VITE_PORT ?? 9004),
    // strictPort：端口被占用时立即报错退出，避免 Vite 静默 fallback 到下一个可用端口，
    // 进而导致 dev wrapper 的 waitForHealth 命中错误端口报出"启动超时"。
    strictPort: true,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${process.env.LLM_PROXY_DEV_BACKEND_PORT ?? 9014}`,
      },
      '/v1': {
        target: `http://127.0.0.1:${process.env.LLM_PROXY_DEV_BACKEND_PORT ?? 9014}`,
      },
      '^/[a-zA-Z0-9_-]+/v1/': {
        target: `http://127.0.0.1:${process.env.LLM_PROXY_DEV_BACKEND_PORT ?? 9014}`,
      },
    },
  },
})
