import { expect, test } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const currentDirectory = dirname(fileURLToPath(import.meta.url))

test('the landing page is server-rendered and does not load WebAssembly', async ({
  page,
}, testInfo) => {
  const pageErrors: string[] = []
  page.on('pageerror', error => pageErrors.push(error.message))

  const response = await page.goto('/')
  expect(response?.ok()).toBe(true)
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN')
  await expect(page.getByRole('heading', { name: '加入房间' })).toBeVisible()
  await expect(page.getByRole('textbox', { name: '房间码' })).toBeVisible()
  await expect(page.getByRole('button', { name: '请求加入' })).toBeEnabled()
  await expect(page.getByRole('link', { name: '创建房间' })).toHaveAttribute(
    'href',
    '/app?intent=create',
  )
  await expect(page.getByRole('link', { name: 'GitHub', exact: true })).toHaveAttribute(
    'href',
    'https://github.com/puzzle-fuzzy/p2p-transmission',
  )

  const roomCode = page.getByRole('textbox', { name: '房间码' })
  await roomCode.fill('ab23cd')
  await expect(roomCode).toHaveValue('AB23CD')

  const resources = await page.evaluate(() =>
    performance.getEntriesByType('resource').map(entry => entry.name),
  )
  expect(resources.some(resource => resource.endsWith('.wasm'))).toBe(false)
  expect(resources.some(resource => resource.includes('p2p-web'))).toBe(false)

  const health = await page.request.get('/health/ready')
  expect(health.ok()).toBe(true)
  expect(await health.json()).toMatchObject({
    status: 'ready',
    service: 'p2p-server',
  })
  const favicon = await page.request.get('/favicon.svg')
  expect(favicon.ok()).toBe(true)
  expect(favicon.headers()['content-type']).toContain('image/svg+xml')
  const manifest = await page.request.get('/manifest.webmanifest')
  expect(manifest.ok()).toBe(true)
  expect(await manifest.json()).toMatchObject({
    display: 'standalone',
    scope: '/',
    start_url: '/',
  })
  await expect.poll(async () => page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return false
    const registration = await navigator.serviceWorker.ready
    return registration.scope === `${location.origin}/`
  })).toBe(true)

  const hasHorizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  )
  expect(hasHorizontalOverflow).toBe(false)
  expect(pageErrors).toEqual([])

  if (process.env.CAPTURE_SHELL === '1') {
    const output = resolve(
      currentDirectory,
      '../docs/release/screenshots',
      `m2-shell-${testInfo.project.name}.png`,
    )
    await mkdir(resolve(output, '..'), { recursive: true })
    await page.screenshot({ path: output, fullPage: true })
  }
})

test('the application entrypoint renders a useful shell before WebAssembly boots', async ({
  page,
}) => {
  await page.route(/\/assets\/p2p-web-.*\.js$/u, route => route.abort())
  const response = await page.goto('/app')
  expect(response?.ok()).toBe(true)
  await expect(page.getByRole('heading', { name: '正在准备安全传输' })).toBeVisible()
  await expect(page.getByRole('status')).toContainText('加载传输工作区')
  await expect(page.locator('#boot-fallback')).toHaveAttribute('aria-busy', 'true')
})

test('the installed PWA keeps a useful shell available offline', async ({ context, page }) => {
  await page.goto('/')
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready
  })
  await page.reload()
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true)

  await context.setOffline(true)
  try {
    const response = await page.goto('/app', { waitUntil: 'domcontentloaded' })
    expect(response?.ok()).toBe(true)
    await expect(page.getByRole('heading', { name: '正在准备安全传输' })).toBeVisible()
  } finally {
    await context.setOffline(false)
  }
})

test('the WebAssembly application remains accessible at the on-demand entrypoint', async ({
  page,
}) => {
  const pageErrors: string[] = []
  page.on('pageerror', error => pageErrors.push(error.message))

  const response = await page.goto('/app')
  expect(response?.ok()).toBe(true)
  await expect(page.getByRole('heading', { name: '加入房间' })).toBeVisible()
  await expect(page.getByRole('button', { name: '创建房间' })).toBeEnabled()
  await expect(page.getByRole('button', { name: '请求加入' })).toBeDisabled()

  const aboutButton = page.getByRole('button', { name: '关于 P2P Transmission' })
  await aboutButton.click()
  const aboutDialog = page.getByRole('dialog', { name: '关于 P2P Transmission' })
  await expect(aboutDialog).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(aboutDialog).toBeHidden()
  await expect(aboutButton).toBeFocused()
  expect(pageErrors).toEqual([])
})
