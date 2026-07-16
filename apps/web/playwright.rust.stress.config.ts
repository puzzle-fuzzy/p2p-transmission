import { defineConfig, devices } from '@playwright/test'
import baseConfig from './playwright.rust.config'

export default defineConfig({
  ...baseConfig,
  testMatch: ['large-file.stress.spec.ts'],
  timeout: 30 * 60 * 1000,
  expect: { timeout: 30_000 },
  workers: 1,
  projects: [
    {
      name: 'desktop-chromium-stress',
      use: {
        ...devices['Desktop Chrome'],
        bypassCSP: true,
        viewport: { width: 1440, height: 960 },
      },
    },
  ],
})
