import { defineConfig, devices } from '@playwright/test'
import { resolve } from 'node:path'

const repositoryRoot = resolve(import.meta.dirname, '../..')
const apiUrl = 'http://127.0.0.1:3332'
const webUrl = 'http://127.0.0.1:5714'

export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: webUrl,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'bun services/api/src/index.ts',
      cwd: repositoryRoot,
      url: `${apiUrl}/health`,
      timeout: 30_000,
      reuseExistingServer: false,
      env: {
        ...process.env,
        PORT: '3332',
        DATABASE_PATH: ':memory:',
        CORS_ALLOWED_ORIGINS: webUrl,
        STUN_URLS: '',
      },
    },
    {
      command: 'bun run dev -- --host 127.0.0.1 --port 5714',
      cwd: resolve(repositoryRoot, 'apps/web'),
      url: webUrl,
      timeout: 30_000,
      reuseExistingServer: false,
      env: {
        ...process.env,
        VITE_API_URL: apiUrl,
        VITE_TURN_MODE: 'off',
        VITE_ICE_TRANSPORT_POLICY: 'all',
        VITE_STUN_URLS: '',
      },
    },
  ],
})
