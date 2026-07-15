import { defineConfig, devices } from '@playwright/test'
import { resolve } from 'node:path'

const spikeRoot = resolve(import.meta.dirname, '../../spikes/dioxus-webrtc')
const webRoot = resolve(spikeRoot, 'web')

export default defineConfig({
  testDir: './e2e',
  testMatch: 'rust-spike.capture.ts',
  timeout: 180_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:8080',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: [
    {
      command: 'cargo run -p p2p-spike-server',
      cwd: spikeRoot,
      url: 'http://127.0.0.1:3340/health',
      timeout: 120_000,
      reuseExistingServer: true,
    },
    {
      command: 'dx serve --web --addr 127.0.0.1 --port 8080 --open false',
      cwd: webRoot,
      url: 'http://127.0.0.1:8080',
      timeout: 120_000,
      reuseExistingServer: true,
    },
  ],
})
