import { defineConfig, devices } from '@playwright/test';

const BASE_URL = process.env.LLM_PROXY_BASE_URL ?? 'http://127.0.0.1:9000';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: BASE_URL,
    extraHTTPHeaders: { 'x-llm-proxy': 'playwright' },
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: process.env.LLM_PROXY_NO_WEBSERVER
    ? undefined
    : {
        command: 'npm run dev',
        url: `${BASE_URL}/health`,
        reuseExistingServer: true,
        timeout: 30_000,
        stdout: 'ignore',
        stderr: 'pipe',
      },
});
