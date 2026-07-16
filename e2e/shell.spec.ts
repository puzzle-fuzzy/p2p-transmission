import { expect, test } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const currentDirectory = dirname(fileURLToPath(import.meta.url))

test('the root renders the Dioxus transfer workspace', async ({ page }, testInfo) => {
  const pageErrors: string[] = []
  page.on('pageerror', error => pageErrors.push(error.message))

  const response = await page.goto('/')
  expect(response?.ok()).toBe(true)
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN')
  await expect(page.getByRole('heading', { name: '加入房间' })).toBeVisible()
  await expect(page.locator('#boot-fallback')).toHaveCount(0)

  const roomCode = page.getByRole('textbox', { name: '输入 6 位房间码' })
  await expect(roomCode).toBeVisible()
  await expect(page.getByRole('button', { name: '请求加入' })).toBeDisabled()
  await expect(page.getByRole('button', { name: '创建房间' })).toBeEnabled()
  await roomCode.fill('ab23cd')
  await expect(roomCode).toHaveValue('AB23CD')
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
      'p2p_room_session',
      JSON.stringify({
        room_code: 'ABC234',
        role: 'receiver',
        join_request_id: 'join_pending',
        invite_request_id: null,
        peer_id: null,
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
    () => window.localStorage.getItem('p2p_room_session'),
  )).toBeNull()
})

test('the root keeps a useful boot fallback before WebAssembly starts', async ({ page }) => {
  await page.route(/\/assets\/p2p-web-.*\.js$/u, route => route.abort())
  const response = await page.goto('/')
  expect(response?.ok()).toBe(true)
  await expect(page.locator('#boot-fallback')).toBeVisible()
  await expect(page.locator('#boot-fallback')).toHaveAttribute('aria-busy', 'true')
  await expect(page.locator('#boot-fallback')).toContainText('正在准备')
  await expect(page.getByRole('status')).toBeVisible()
})

test('the installed PWA keeps the root workspace available offline', async ({ context, page }) => {
  await page.goto('/')
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready
  })
  const cachedPaths = await page.evaluate(async () => {
    const cacheNames = await caches.keys()
    const requests = await Promise.all(cacheNames
      .filter(name => name.startsWith('p2p-transmission-'))
      .map(async name => (await caches.open(name)).keys()))
    return requests.flat().map(request => new URL(request.url).pathname)
  })
  expect(cachedPaths).toContain('/')
  expect(cachedPaths).toContain('/shell/app.css')
  expect(cachedPaths.some(path => path.endsWith('.wasm'))).toBe(true)
  expect(cachedPaths).not.toContain('/app')
  expect(cachedPaths).not.toContain('/app/')
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

test('unknown routes and missing assets return 404', async ({ request }) => {
  for (const path of ['/unknown-route', '/assets/missing.js', '/appx']) {
    const response = await request.get(path, { maxRedirects: 0 })
    expect(response.status()).toBe(404)
  }
})

test.describe('legacy /app route compatibility', () => {
  test('old application entrypoints redirect temporarily and preserve queries', async ({ request }) => {
    for (const [path, location] of [
      ['/app', '/'],
      ['/app/', '/'],
      ['/index.html', '/'],
      ['/app?intent=create', '/?intent=create'],
      ['/app/?room=ABC234', '/?room=ABC234'],
    ] as const) {
      const response = await request.get(path, { maxRedirects: 0 })
      expect(response.status()).toBe(307)
      expect(response.headers()['location']).toBe(location)
      expect(response.headers()['cache-control']).toContain('no-store')
    }
  })

  test('an old hash invitation redirects to root and still submits the join request', async ({
    baseURL,
    browser,
  }) => {
    const ownerContext = await browser.newContext({ baseURL })
    const receiverContext = await browser.newContext({ baseURL })
    const owner = await ownerContext.newPage()
    const receiver = await receiverContext.newPage()

    try {
      await owner.goto('/')
      const inviteResponse = owner.waitForResponse(response => {
        const path = new URL(response.url()).pathname
        return response.request().method() === 'POST'
          && /^\/api\/rooms\/[A-Z2-9]{6}\/invite-capabilities$/u.test(path)
      })
      const createButton = owner.getByRole('button', { name: '创建房间' })
      await expect(createButton).toBeEnabled()
      await createButton.click()

      const invite = await (await inviteResponse).json() as { capability: string }
      const roomCodeButton = owner.getByRole('button', { name: /复制房间码/ })
      await expect(roomCodeButton).toBeVisible()
      const roomCode = (await roomCodeButton.textContent())?.trim() ?? ''
      expect(roomCode).toMatch(/^[A-Z2-9]{6}$/u)
      expect(invite.capability).not.toBe('')

      const legacyInvite = new URL('/app', baseURL ?? 'http://127.0.0.1:3410')
      legacyInvite.hash = `room=${roomCode}&capability=${invite.capability}`
      const response = await receiver.goto(legacyInvite.href)
      expect(response?.ok()).toBe(true)

      await expect.poll(() => receiver.evaluate(() => window.location.pathname)).toBe('/')
      await expect(receiver).toHaveURL(url => url.pathname === '/' && url.hash === '')
      await expect(receiver.getByRole('heading', { name: '等待发送者确认' })).toBeVisible()
      await expect(owner.getByRole('dialog', { name: '加入申请' })).toBeVisible()
    } finally {
      await receiverContext.close()
      await ownerContext.close()
    }
  })
})
