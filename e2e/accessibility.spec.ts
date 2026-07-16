import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'

async function expectNoAccessibilityViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze()

  expect(
    results.violations,
    JSON.stringify(results.violations, null, 2),
  ).toEqual([])
}

async function expectNoHorizontalOverflow(page: Page) {
  expect(await page.evaluate(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
  )).toBe(true)
}

test('the server-rendered landing page passes WCAG axe rules', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '加入房间' })).toBeVisible()
  await expectNoAccessibilityViolations(page)
})

test('the WebAssembly application entrypoint passes WCAG axe rules', async ({ page }) => {
  await page.goto('/app')
  await expect(page.getByRole('heading', { name: '加入房间' })).toBeVisible()
  await expectNoAccessibilityViolations(page)

  await page.getByRole('button', { name: '关于 P2P Transmission' }).click()
  const aboutDialog = page.getByRole('dialog', { name: '关于 P2P Transmission' })
  await expect(aboutDialog).toBeVisible()
  await expect(aboutDialog).toHaveCSS('opacity', '1')
  await expectNoAccessibilityViolations(page)
})

test('essential flows survive forced colors and 200% text scaling', async ({
  baseURL,
  browser,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium')

  const context = await browser.newContext({
    baseURL,
    forcedColors: 'active',
    viewport: { width: 640, height: 900 },
  })
  const page = await context.newPage()

  try {
    await page.goto('/')
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '200%'
    })
    const roomCode = page.getByRole('textbox', { name: '房间码' })
    await expect(page.getByRole('heading', { name: '加入房间' })).toBeVisible()
    await expect(roomCode).toBeVisible()
    await expect(page.getByRole('button', { name: '请求加入' })).toBeVisible()
    await roomCode.focus()
    expect(await roomCode.evaluate(element => {
      const style = getComputedStyle(element)
      return style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) >= 2
    })).toBe(true)
    await expectNoHorizontalOverflow(page)

    await page.goto('/app')
    await expect(page.getByRole('heading', { name: '加入房间' })).toBeVisible()
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '200%'
    })
    await expect(page.getByRole('button', { name: '创建房间' })).toBeVisible()
    await expect(page.getByRole('button', { name: '请求加入' })).toBeVisible()
    await expectNoHorizontalOverflow(page)
  } finally {
    await context.close()
  }
})
