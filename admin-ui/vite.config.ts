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
    proxy: {
      '/admin': 'http://localhost:9000',
    },
  },
})
