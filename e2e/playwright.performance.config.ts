import { defineConfig } from '@playwright/test'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const currentDirectory = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(currentDirectory, '..')
const performancePort = process.env.P2P_PERFORMANCE_PORT ?? '3411'
const baseURL = `http://127.0.0.1:${performancePort}`
const allProjects = [
  {
    name: 'performance-chromium',
    use: {
      browserName: 'chromium' as const,
      viewport: { width: 1440, height: 960 },
    },
  },
  {
    name: 'performance-chromium-narrow',
    use: {
      browserName: 'chromium' as const,
      viewport: { width: 390, height: 844 },
    },
  },
]
const selectedProject = process.env.P2P_PERFORMANCE_PROJECT
const projects = selectedProject
  ? allProjects.filter(project => project.name === selectedProject)
  : allProjects

if (projects.length === 0) {
  throw new Error(`Unknown performance project: ${selectedProject}`)
}

export default defineConfig({
  testDir: '.',
  testMatch: ['performance.spec.ts'],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: 'list',
  outputDir: `../test-results/performance/${selectedProject ?? 'all'}`,
  use: {
    baseURL,
    trace: 'retain-on-failure',
  },
  projects,
  webServer: {
    command: `python -X utf8 scripts/dev.py --profile release --addr 127.0.0.1:${performancePort}`,
    cwd: repositoryRoot,
    env: {
      P2P_ALLOWED_ORIGINS: baseURL,
      P2P_DATABASE_PATH: resolve(
        repositoryRoot,
        `target/p2p/performance-${selectedProject ?? 'all'}.sqlite3`,
      ),
      P2P_SESSION_RATE_MAX: '200',
    },
    url: `${baseURL}/health/ready`,
    reuseExistingServer: false,
    timeout: 180_000,
  },
})
