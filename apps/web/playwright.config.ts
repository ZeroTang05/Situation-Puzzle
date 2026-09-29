/** 使用已启动的真实服务；测试不会自动启动服务或替换接口。 */
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  use: { baseURL: process.env.E2E_WEB_URL ?? 'http://localhost:5173', ...devices['Desktop Chrome'], permissions: ['clipboard-read', 'clipboard-write'] },
});
