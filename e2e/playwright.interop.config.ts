import { defineConfig } from '@playwright/test'

import fullConfig from './playwright.config'

const interopProjectNames = ['desktop-firefox', 'desktop-webkit']
const interopProjects = interopProjectNames.map(name => {
  const project = fullConfig.projects?.find(candidate => candidate.name === name)
  if (!project) {
    throw new Error(`${name} project is required for the interop smoke suite`)
  }
  return project
})

export default defineConfig({
  ...fullConfig,
  grep: /@interop-smoke/u,
  outputDir: '../test-results/interop',
  projects: interopProjects,
})
