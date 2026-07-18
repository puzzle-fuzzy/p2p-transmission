import { expect, test } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const currentDirectory = dirname(fileURLToPath(import.meta.url))

test('the root renders the Dioxus transfer workspace', { tag: '@smoke' }, async ({ page }, testInfo) => {
  const pageErrors: string[] = []
  page.on('pageerror', error => pageErrors.push(error.message))

  const response = await page.goto('/')
  expect(response?.ok()).toBe(true)
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN')
  await expect(page.getByRole('heading', { name: '加入房间' })).toBeVisible()
  await expect(page.locator('#boot-fallback')).toHaveCount(0)

  const roomCodeGroup = page.getByRole('group', { name: '输入 6 位房间码' })
  const roomCodeInputs = roomCodeGroup.getByRole('textbox')
  const roomCode = page.getByRole('textbox', { name: '输入 6 位房间码' })
  await expect(roomCodeInputs).toHaveCount(6)
  await expect(roomCode).toBeVisible()
  await expect(page.getByRole('button', { name: '请求加入' })).toBeDisabled()
  await expect(page.getByRole('button', { name: '创建房间' })).toBeEnabled()
  await roomCode.focus()
  await page.keyboard.type('a')
  await expect(roomCodeInputs.nth(1)).toBeFocused()
  await page.keyboard.press('Backspace')
  await expect(roomCode).toBeFocused()
  await roomCode.evaluate(input => {
    const clipboardData = new DataTransfer()
    clipboardData.setData('text', 'ab23cd')
    input.dispatchEvent(new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData,
    }))
  })
  expect(await roomCodeInputs.evaluateAll(inputs => inputs.map(input => (
    (input as HTMLInputElement).value
  )))).toEqual(['A', 'B', '2', '3', 'C', 'D'])
  await expect(roomCodeInputs.nth(5)).toBeFocused()
  expect(await roomCodeInputs.nth(5).evaluate(element => (
    getComputedStyle(element).caretColor
  ))).not.toBe('rgba(0, 0, 0, 0)')
  expect(await roomCodeInputs.nth(5).evaluate(element => {
    const input = element as HTMLInputElement
    return [input.selectionStart, input.selectionEnd]
  })).toEqual([1, 1])
  await expect(page.getByRole('button', { name: '请求加入' })).toBeEnabled()

  const resources = await page.evaluate(() =>
    performance.getEntriesByType('resource').map(entry => entry.name),
  )
  expect(resources.some(resource => resource.endsWith('.wasm'))).toBe(true)
  expect(resources.some(resource => resource.includes('p2p-web'))).toBe(true)

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
    id: '/',
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

test('an invalid stored room is cleared without a navigation trap', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => {
    window.localStorage.setItem(
      'p2p_room_session_v5',
      JSON.stringify({
        schema_version: 5,
        session: {
          room_code: 'ABC234',
          role: 'receiver',
          join_request_id: 'join_pending',
          invite_request_id: null,
          peer_id: null,
        },
      }),
    )
  })
  await page.route('**/api/sessions', route => route.fulfill({
    status: 503,
    contentType: 'application/json',
    body: JSON.stringify({ error: { code: 'unavailable', message: 'temporary outage' } }),
  }))

  await page.reload()
  await expect.poll(() => page.evaluate(() => window.location.pathname)).toBe('/')
  await expect(page.getByRole('heading', { name: '加入房间' })).toBeVisible()
  await expect.poll(() => page.evaluate(
    () => window.localStorage.getItem('p2p_room_session_v5'),
  )).toBeNull()
})

test('a valid stored room selects the restoration shell before the first paint', async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem(
      'p2p_room_session_v5',
      JSON.stringify({
        schema_version: 5,
        session: {
          room_code: 'ABC234',
          role: 'receiver',
          join_request_id: 'join_restoring',
          invite_request_id: null,
          peer_id: 'peer_restoring',
        },
      }),
    )
  })
  await page.route(/\/shell\/app-shell\.css(?:\?.*)?$/u, route => route.abort())
  await page.route(/\.wasm(?:\?.*)?$/u, route => route.abort())

  const response = await page.goto('/', { waitUntil: 'domcontentloaded' })
  expect(response?.ok()).toBe(true)
  await expect(page.locator('html')).toHaveAttribute('data-p2p-room-restore', 'pending')

  const fallback = page.locator('#boot-fallback')
  const restorationShell = fallback.locator('.boot-room-restore')
  await expect(restorationShell).toBeVisible()
  await expect(restorationShell.getByRole('status')).toContainText('正在恢复上次房间，请稍候')
  await expect(fallback.locator('.boot-lobby-shell')).toBeHidden()
  await expect(fallback.getByRole('heading', { name: '加入房间' })).toBeHidden()
  await expect(fallback.getByRole('button', { name: '请求加入' })).toBeHidden()
  await expect(fallback.getByRole('button', { name: '创建房间' })).toBeHidden()
})

test('the root keeps a useful anonymous lobby when WebAssembly is blocked', { tag: '@smoke' }, async ({ page }) => {
  let blockedWasmRequest = false
  await page.route(/\/shell\/app-shell\.css(?:\?.*)?$/u, route => route.abort())
  await page.route(/\.wasm(?:\?.*)?$/u, route => {
    blockedWasmRequest = true
    return route.abort()
  })
  const response = await page.goto('/')
  expect(response?.ok()).toBe(true)
  expect(blockedWasmRequest).toBe(true)
  const shell = page.locator('#boot-fallback')
  await expect(shell).toBeVisible()
  await expect(shell.locator('.boot-room-restore')).toBeHidden()
  expect(await shell.getAttribute('aria-busy')).toBeNull()
  await expect(shell.getByRole('heading', { name: '加入房间' })).toBeVisible()
  await expect(shell.locator('.boot-room-code-cell')).toHaveCount(6)
  await expect(shell.getByRole('status')).toContainText('正在初始化安全会话')
  await expect(shell.getByRole('button', { name: '请求加入' })).toBeDisabled()
  await expect(shell.getByRole('button', { name: '创建房间' })).toBeDisabled()
  await expect(shell.getByRole('textbox')).toHaveCount(0)
  await expect(shell.locator('.footer-links .text-link').first()).toHaveText('关于')
  await expect(shell.locator(
    'a[href], input:not(:disabled), button:not(:disabled), [tabindex]:not([tabindex="-1"])',
  )).toHaveCount(0)
})

test('the installed PWA keeps the root workspace available offline', async ({ context, page }) => {
  await page.goto('/')
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready
  })
  const cachedUrls = await page.evaluate(async () => {
    const cacheNames = await caches.keys()
    const requests = await Promise.all(cacheNames
      .filter(name => name.startsWith('p2p-transmission-'))
      .map(async name => (await caches.open(name)).keys()))
    return requests.flat().map(request => {
      const url = new URL(request.url)
      return `${url.pathname}${url.search}`
    })
  })
  expect(cachedUrls).toContain('/')
  expect(cachedUrls).toEqual(expect.arrayContaining([
    expect.stringMatching(/^\/shell\/app-shell\.css\?v=[A-Za-z0-9._-]+$/u),
    expect.stringMatching(/^\/shell\/room-restore\.js\?v=[A-Za-z0-9._-]+$/u),
    expect.stringMatching(/^\/shell\/app-shell\.js\?v=[A-Za-z0-9._-]+$/u),
  ]))
  expect(cachedUrls).not.toContain('/shell/app-shell.css')
  expect(cachedUrls).not.toContain('/shell/app.css')
  expect(cachedUrls.some(path => path.endsWith('.wasm'))).toBe(true)
  expect(cachedUrls).not.toContain('/app')
  expect(cachedUrls).not.toContain('/app/')
  await page.reload()
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true)
  await expect(page.getByRole('heading', { name: '加入房间' })).toBeVisible()

  await context.setOffline(true)
  try {
    const response = await page.goto('/', { waitUntil: 'domcontentloaded' })
    expect(response?.ok()).toBe(true)
    await expect.poll(() => page.evaluate(() => window.location.pathname)).toBe('/')
    await expect(page.getByRole('heading', { name: '加入房间' })).toBeVisible()

    const missing = await page.goto('/unknown-route', { waitUntil: 'domcontentloaded' })
    expect(missing?.status()).toBe(503)
    await expect(page.getByText('离线时无法访问此地址')).toBeVisible()
  } finally {
    await context.setOffline(false)
  }
})

test('unknown routes, removed historical routes, and missing assets return 404', async ({ request }) => {
  for (const path of [
    '/unknown-route',
    '/assets/missing.js',
    '/app',
    '/app/',
    '/app?intent=create',
    '/app/?room=ABC234',
    '/appx',
    '/index.html',
    '/shell/app.css',
  ]) {
    const response = await request.get(path, { maxRedirects: 0 })
    expect(response.status()).toBe(404)
  }
})
