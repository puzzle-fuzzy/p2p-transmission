import { expect, test } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const currentDirectory = dirname(fileURLToPath(import.meta.url))

test('the root renders the Dioxus transfer workspace', { tag: '@smoke' }, async ({ page }, testInfo) => {
  const pageErrors: string[] = []
  page.on('pageerror', error => pageErrors.push(error.message))
  await page.addInitScript(() => {
    const probe = {
      overflowFrames: 0,
      overflows: [] as Array<{
        bootFallback: boolean
        clientHeight: number
        mainHidden: boolean
        sample: number
        shells: Array<{ className: string, display: string, height: number, top: number }>
        scrollHeight: number
        time: number
      }>,
      samples: 0,
    }
    Object.assign(window, { __p2pOverflowProbe: probe })
    const sample = () => {
      probe.samples += 1
      if (document.documentElement.scrollHeight > document.documentElement.clientHeight) {
        probe.overflowFrames += 1
        probe.overflows.push({
          bootFallback: document.querySelector('#boot-fallback') !== null,
          clientHeight: document.documentElement.clientHeight,
          mainHidden: document.querySelector('#main')?.hasAttribute('hidden') ?? true,
          sample: probe.samples,
          shells: [...document.querySelectorAll<HTMLElement>('.app-shell')].map(shell => {
            const rect = shell.getBoundingClientRect()
            return {
              className: shell.className,
              display: getComputedStyle(shell).display,
              height: rect.height,
              top: rect.top,
            }
          }),
          scrollHeight: document.documentElement.scrollHeight,
          time: performance.now(),
        })
      }
      if (probe.samples < 180) requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
  })

  const response = await page.goto('/')
  expect(response?.ok()).toBe(true)
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN')
  await expect(page.getByRole('heading', { name: '加入房间' })).toBeVisible()
  await expect(page.locator('#boot-fallback')).toHaveCount(0)

  const roomCode = page.getByRole('textbox', { name: '输入 6 位房间码' })
  await expect(roomCode).toHaveCount(1)
  await expect(page.locator('input[name="room_code"]')).toHaveCount(1)
  await expect(page.locator('fieldset.room-code, .room-code-input')).toHaveCount(0)
  await expect(roomCode).toBeVisible()
  const joinButton = page.getByRole('button', { name: '请求加入' })
  await expect(joinButton).toBeDisabled()
  expect(await joinButton.evaluate(element => getComputedStyle(element).backgroundColor)).toBe(
    'rgb(46, 46, 44)',
  )
  await expect(page.getByRole('button', { name: '创建房间' })).toBeEnabled()
  await expect(page.locator('.create-panel .generated-code')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '复制房间号', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '创建并进入', exact: true })).toHaveCount(0)
  await expect(page.locator('.create-panel').getByRole('button')).toHaveCount(1)
  const githubLink = page.getByRole('link', { name: 'GitHub ↗' })
  await expect(githubLink).toBeVisible()
  await expect(page.getByText('Files never touch our servers')).toHaveCount(0)
  await expect(page.getByText('E2E Encrypted')).toHaveCount(0)
  await expect(page.getByText('Vault', { exact: true })).toHaveCount(0)

  const createButton = page.getByRole('button', { name: '创建房间' })
  const createButtonBackground = await createButton.evaluate(element => (
    getComputedStyle(element).backgroundColor
  ))
  await createButton.hover()
  await expect.poll(() => createButton.evaluate(element => (
    getComputedStyle(element).backgroundColor
  ))).not.toBe(createButtonBackground)

  if (testInfo.project.name === 'desktop-chromium') {
    const layout = await page.locator('.app-shell').evaluate(shell => {
      const room = shell.querySelector('.transfer-layout') as HTMLElement | null
      const identity = shell.querySelector('.transfer-identity')?.getBoundingClientRect()
      const consolePanel = shell.querySelector('.transfer-console')?.getBoundingClientRect()
      const roomRect = room?.getBoundingClientRect()
      return {
        display: room ? getComputedStyle(room).display : '',
        identityRight: identity?.right ?? -1,
        consoleLeft: consolePanel?.left ?? -1,
        top: roomRect?.top ?? -1,
        bottom: roomRect ? innerHeight - roomRect.bottom : -1,
      }
    })
    expect(layout.display).toBe('grid')
    expect(layout.identityRight).toBeLessThanOrEqual(layout.consoleLeft + 1)
  }

  await roomCode.focus()
  await page.keyboard.type('a')
  await expect(roomCode).toHaveValue('A')
  await page.keyboard.press('Backspace')
  await expect(roomCode).toHaveValue('')
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
  await expect(roomCode).toHaveValue('AB23CD')
  await expect(roomCode).toBeFocused()
  expect(await roomCode.evaluate(element => (
    getComputedStyle(element).caretColor
  ))).not.toBe('rgba(0, 0, 0, 0)')
  expect(await roomCode.evaluate(element => {
    const input = element as HTMLInputElement
    return [input.selectionStart, input.selectionEnd]
  })).toEqual([6, 6])
  await expect(joinButton).toBeEnabled()
  await expect.poll(() => joinButton.evaluate(
    element => getComputedStyle(element).backgroundColor,
  )).toBe('rgb(17, 17, 17)')

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
  const faviconIco = await page.request.get('/favicon.ico')
  expect(faviconIco.ok()).toBe(true)
  expect(faviconIco.headers()['content-type']).toContain('image/x-icon')
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

  if (testInfo.project.name === 'mobile-chromium') {
    await page.setViewportSize({ width: 812, height: 375 })
    await expect(page.getByRole('heading', { name: '加入房间' })).toBeVisible()
    await expect(page.getByRole('button', { name: '创建房间' })).toBeVisible()
    expect(await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    )).toBe(false)

    if (process.env.CAPTURE_SHELL === '1') {
      const landscapeOutput = resolve(
        currentDirectory,
        '../docs/release/screenshots/m2-shell-mobile-landscape-chromium.png',
      )
      await page.screenshot({ path: landscapeOutput, fullPage: true })
    }
  }
})

test('file queues stay within their columns and download links stay undecorated', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => {
    const fixture = document.createElement('div')
    fixture.id = 'layout-regression-fixture'
    fixture.style.cssText = 'position:fixed;left:-10000px;top:0;width:280px;'
    fixture.innerHTML = `
      <div class="file-list" id="layout-file-list">
        <div class="transfer-file-list">
          <div class="transfer-file-row">
            <div class="transfer-file-meta">
              <strong>${'very-long-file-name-'.repeat(18)}.zip</strong>
              <div class="transfer-file-secondary"><span>1.2 GB</span><span>传输中 87%</span></div>
            </div>
          </div>
        </div>
      </div>
      <div class="request-file-list" id="layout-request-file-list">
        <div class="request-file-summary"><strong>${'another-extremely-long-file-name-'.repeat(16)}.bin</strong><span>4 GB</span></div>
      </div>
      <a class="transfer-download" href="/download">保存文件</a>
    `
    document.body.append(fixture)
  })

  const metrics = await page.locator('#layout-regression-fixture').evaluate(element => {
    const fileList = element.querySelector<HTMLElement>('#layout-file-list')
    const requestFileList = element.querySelector<HTMLElement>('#layout-request-file-list')
    const download = element.querySelector<HTMLElement>('.transfer-download')
    return {
      fileList: fileList ? { clientWidth: fileList.clientWidth, scrollWidth: fileList.scrollWidth } : null,
      requestFileList: requestFileList
        ? { clientWidth: requestFileList.clientWidth, scrollWidth: requestFileList.scrollWidth }
        : null,
      textDecoration: download ? getComputedStyle(download).textDecorationLine : null,
    }
  })

  expect(metrics.fileList).not.toBeNull()
  expect(metrics.requestFileList).not.toBeNull()
  expect(metrics.fileList?.scrollWidth).toBeLessThanOrEqual(metrics.fileList?.clientWidth ?? 0)
  expect(metrics.requestFileList?.scrollWidth).toBeLessThanOrEqual(metrics.requestFileList?.clientWidth ?? 0)
  expect(metrics.textDecoration).toBe('none')
})

test('a newly activated application release asks the user to refresh', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '加入房间' })).toBeVisible()

  await page.evaluate(() => {
    document.documentElement.setAttribute('data-p2p-upgrade', 'true')
    window.dispatchEvent(new Event('p2p-app-update'))
  })

  const dialog = page.getByRole('alertdialog', { name: '需要刷新页面' })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('正在进行的传输会中断')
  await expect(dialog.getByRole('button', { name: '刷新并升级' })).toBeVisible()
})

test('a protocol mismatch stops boot and presents the upgrade action', async ({ page }) => {
  await page.route('**/api/meta', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      product: 'P2P Transmission',
      version: '2.0.1',
      release: 'stale-test',
      api_major: 5,
      api_minor: 0,
      capabilities: 7,
    }),
  }))

  await page.goto('/')

  await expect(page.getByRole('alertdialog', { name: '需要刷新页面' })).toBeVisible()
  await expect(page.getByRole('button', { name: '刷新并升级' })).toBeVisible()
  await expect(page.getByRole('heading', { name: '加入房间' })).toBeVisible()
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
  await expect(shell.locator('.boot-room-code')).toHaveCount(1)
  await expect(shell.getByRole('status')).toContainText('正在初始化安全会话')
  await expect(shell.getByRole('button', { name: '请求加入' })).toBeDisabled()
  await expect(shell.getByRole('button', { name: '创建房间' })).toBeDisabled()
  await expect(shell.getByRole('textbox')).toHaveCount(0)
  await expect(shell.locator('.footer-inline-actions .footer-about-link')).toHaveText('关于')
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
