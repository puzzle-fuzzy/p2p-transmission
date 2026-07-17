import { defineConfig } from '@playwright/test'

import fullConfig from './playwright.config'

const desktopChromium = fullConfig.projects?.find(project => (
  project.name === 'desktop-chromium'
))

if (!desktopChromium) {
  throw new Error('desktop-chromium project is required for the smoke suite')
}

export default defineConfig({
  ...fullConfig,
  grep: /@smoke/u,
  projects: [desktopChromium],
})
