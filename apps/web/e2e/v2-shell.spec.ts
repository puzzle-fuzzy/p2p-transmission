import { expect, test } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const currentDirectory = dirname(fileURLToPath(import.meta.url))

test('Rust 2.0 shell is healthy, accessible, and responsive', async ({ page }, testInfo) => {
  const response = await page.goto('/')
  expect(response?.ok()).toBe(true)

  await expect(page.getByRole('heading', { name: '加入房间' })).toBeVisible()
  await expect(page.getByRole('button', { name: '创建房间' })).toBeEnabled()
  await expect(page.getByRole('button', { name: '请求加入' })).toBeDisabled()
  await expect(page.getByRole('link', { name: 'GitHub', exact: true })).toHaveAttribute(
    'href',
    'https://github.com/puzzle-fuzzy/p2p-transmission',
  )

  await page.getByRole('button', { name: '关于 P2P Transmission' }).click()
  await expect(page.getByRole('heading', { name: '关于 P2P Transmission 2.0' })).toBeVisible()
  await page.getByRole('button', { name: '关闭' }).click()
  await expect(page.getByRole('heading', { name: '关于 P2P Transmission 2.0' })).toBeHidden()

  const health = await page.request.get('/health/ready')
  expect(health.ok()).toBe(true)
  expect(await health.json()).toMatchObject({
    status: 'ready',
    service: 'p2p-server',
  })

  const hasHorizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  )
  expect(hasHorizontalOverflow).toBe(false)

  if (process.env.CAPTURE_V2_SHELL === '1') {
    const output = resolve(
      currentDirectory,
      '../../../docs/rust-v2/screenshots',
      `m2-shell-${testInfo.project.name}.png`,
    )
    await mkdir(resolve(output, '..'), { recursive: true })
    await page.screenshot({ path: output, fullPage: true })
  }
})
