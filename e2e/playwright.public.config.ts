import { defineConfig } from '@playwright/test'

const baseURL = process.env.P2P_PUBLIC_BASE_URL
if (!baseURL) {
  throw new Error('P2P_PUBLIC_BASE_URL is required for public release verification')
}

// The public TURN path is a live shared network boundary. Allow one complete
// CI rerun to absorb transient ICE allocation jitter while keeping local runs
// deterministic and preserving a failing signal when the second attempt fails.
const publicCiRetries = process.env.CI === 'true' ? 1 : 0

const publicOrigin = new URL(baseURL)
if (
  publicOrigin.protocol !== 'https:'
  || publicOrigin.username
  || publicOrigin.password
  || !['', '/'].includes(publicOrigin.pathname)
  || publicOrigin.search
  || publicOrigin.hash
) {
  throw new Error('P2P_PUBLIC_BASE_URL must be a plain HTTPS origin')
}

export default defineConfig({
  testDir: '.',
  testMatch: ['public-release.spec.ts'],
  fullyParallel: false,
  workers: 1,
  retries: publicCiRetries,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: 'list',
  use: {
    baseURL: publicOrigin.origin,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'public-relay-chromium',
      use: {
        browserName: 'chromium',
        viewport: { width: 1280, height: 800 },
      },
    },
  ],
})
