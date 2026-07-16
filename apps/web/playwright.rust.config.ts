import { defineConfig } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const currentDirectory = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(currentDirectory, '../..')

export default defineConfig({
  testDir: './e2e',
  testMatch: [
    'shell.spec.ts',
    'room.spec.ts',
    'transfer.spec.ts',
    'compat.spec.ts',
  ],
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:3410',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'desktop-chromium',
      testIgnore: ['compat.spec.ts'],
      use: { browserName: 'chromium', viewport: { width: 1440, height: 960 } },
    },
    {
      name: 'mobile-chromium',
      testIgnore: ['compat.spec.ts'],
      use: {
        browserName: 'chromium',
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      name: 'desktop-firefox',
      testMatch: ['compat.spec.ts'],
      use: { browserName: 'firefox', viewport: { width: 1440, height: 960 } },
    },
    {
      name: 'desktop-webkit',
      testMatch: ['compat.spec.ts'],
      use: { browserName: 'webkit', viewport: { width: 1440, height: 960 } },
    },
  ],
  webServer: {
    command: 'python -X utf8 scripts/dev.py --profile release',
    cwd: repositoryRoot,
    env: { P2P_SESSION_RATE_MAX: '200' },
    url: 'http://127.0.0.1:3410/health/ready',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
})
