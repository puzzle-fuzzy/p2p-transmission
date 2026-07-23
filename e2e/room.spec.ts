import { expect, test } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { enterRoomCode } from './room-code.helper'

const currentDirectory = dirname(fileURLToPath(import.meta.url))
const peerReadyTimeout = 20_000

test('two browsers can create, approve, connect, and restore a room', async ({
  browser,
  baseURL,
}, testInfo) => {
    const ownerContext = await browser.newContext({ baseURL })
    const receiverContext = await browser.newContext({ baseURL })
    await ownerContext.addInitScript(() => {
      const state = {
        notificationPermissionRequests: Number(
          sessionStorage.getItem('test-notification-permission-requests') ?? '0',
        ),
        copiedInvite: null as string | null,
        nativeShareCalls: 0,
      }
      class TestNotification {
        static permission: NotificationPermission = 'default'

        static async requestPermission() {
          state.notificationPermissionRequests += 1
          sessionStorage.setItem(
            'test-notification-permission-requests',
            String(state.notificationPermissionRequests),
          )
          TestNotification.permission = 'granted'
          return 'granted' as NotificationPermission
        }
      }
      Object.defineProperty(window, '__browserCapabilityState', { value: state })
      Object.defineProperty(window, 'Notification', {
        configurable: true,
        value: TestNotification,
      })
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async (value: string) => {
            state.copiedInvite = value
          },
        },
      })
      Object.defineProperty(navigator, 'share', {
        configurable: true,
        value: async () => {
          state.nativeShareCalls += 1
          throw new Error('native share must not be used')
        },
      })
    })
    const owner = await ownerContext.newPage()
    const receiver = await receiverContext.newPage()
    if (testInfo.project.name === 'desktop-chromium') {
      await owner.setViewportSize({ width: 1440, height: 700 })
    }

  try {
    await owner.goto('/')
    await owner.getByRole('button', { name: '创建房间' }).click()
    await expect.poll(() => owner.evaluate(() => (
      window as unknown as {
        __browserCapabilityState: { notificationPermissionRequests: number }
      }
    ).__browserCapabilityState.notificationPermissionRequests)).toBe(1)
    const roomCodeButton = owner.getByRole('button', { name: /复制房间码/ })
    await expect(roomCodeButton).toBeVisible()
    const roomCode = (await roomCodeButton.textContent())?.trim() ?? ''
    expect(roomCode).toMatch(/^[A-Z2-9]{6}$/)
    await expect(owner.getByText('房间已创建，可以复制邀请链接', { exact: true })).toBeVisible()
    await roomCodeButton.click()
    await expect(owner.getByText('房间码已复制', { exact: true })).toBeVisible()
    await expect.poll(() => owner.evaluate(() => (
      window as unknown as {
        __browserCapabilityState: { copiedInvite: string | null }
      }
    ).__browserCapabilityState.copiedInvite)).toBe(roomCode)

    const leaveButton = owner.getByRole('button', { name: '退出房间' })
    await expect(leaveButton.locator('.button-icon')).toBeVisible()

    const shareButton = owner.getByRole('button', { name: '分享房间' })
    await shareButton.click()
    const shareDialog = owner.getByRole('dialog', { name: '分享房间' })
    await expect(shareDialog).toBeVisible()
    await expect(shareDialog).toContainText(roomCode)
    await expect(shareDialog.getByRole('img', { name: `房间 ${roomCode} 的二维码` })).toBeVisible()
    await owner.keyboard.press('Escape')
    await expect(shareDialog).toBeHidden()
    await expect(shareButton).toBeFocused()

    await shareButton.click()
    await shareDialog.getByRole('button', { name: '复制邀请链接' }).click()
    await expect(shareDialog).toBeHidden()
    await expect(owner.getByText('邀请链接已复制', { exact: true })).toBeVisible()
    const clipboardState = await owner.evaluate(() => (
      window as unknown as {
        __browserCapabilityState: { copiedInvite: string | null; nativeShareCalls: number }
      }
    ).__browserCapabilityState)
    expect(clipboardState.copiedInvite).toContain(`#room=${roomCode}&capability=`)
    expect(new URL(clipboardState.copiedInvite ?? 'http://invalid/').pathname).toBe('/')
    expect(clipboardState.nativeShareCalls).toBe(0)

    await receiver.goto('/')
    await enterRoomCode(receiver, roomCode)
    await receiver.keyboard.press('Enter')
    await expect(receiver.getByRole('heading', { name: '等待发送者确认' })).toBeVisible()
    await expect(receiver.getByRole('status')).toContainText('等待确认')
    const waitingAlignment = await receiver.locator('.waiting-view').evaluate(waiting => {
      const waitingRect = waiting.getBoundingClientRect()
      const cardRect = waiting.closest('.workspace-card')?.getBoundingClientRect()
      return cardRect
        ? {
            leftGap: waitingRect.left - cardRect.left,
            rightGap: cardRect.right - waitingRect.right,
          }
        : null
    })
    expect(waitingAlignment).not.toBeNull()
    expect(Math.abs(
      (waitingAlignment?.leftGap ?? 0) - (waitingAlignment?.rightGap ?? 0),
    // The centered work surface can differ by a scrollbar width between browser contexts.
    )).toBeLessThanOrEqual(32)

    const requestDialog = owner.getByRole('dialog', { name: '加入申请' })
    await expect(requestDialog).toBeVisible()
    await owner.keyboard.press('Escape')
    await expect(requestDialog).toBeVisible()
    await requestDialog.getByRole('button', { name: '允许加入' }).click()

    await expect(receiver.getByRole('heading', { name: '等待对方发送' })).toBeVisible({ timeout: peerReadyTimeout })
    await expect(owner.getByRole('heading', { name: '选择要发送的文件' })).toBeVisible({ timeout: peerReadyTimeout })

    const transferLayout = owner.locator('.room-layout')
    const roomFooter = transferLayout.locator('.room-footer')
    const measureRoomSurface = () => owner.evaluate(() => {
      const layout = document.querySelector('.room-layout')?.getBoundingClientRect()
      const footer = document.querySelector('.room-footer')?.getBoundingClientRect()
      return {
        documentHeight: document.documentElement.scrollHeight,
        footerLeft: footer?.left ?? -1,
        footerRight: footer?.right ?? -1,
        footerTop: footer?.top ?? -1,
        layoutLeft: layout?.left ?? -1,
        layoutRight: layout?.right ?? -1,
        layoutTop: layout?.top ?? -1,
        scrollY: window.scrollY,
      }
    })
    await owner.evaluate(() => {
      const maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight)
      window.scrollTo(0, Math.min(260, maxScroll))
    })
    const textTab = owner.getByRole('tab', { name: '文本' })
    await expect(textTab).toBeVisible()
    await textTab.evaluate(element => element.scrollIntoView({ block: 'center', inline: 'nearest' }))
    const fileSurface = await measureRoomSurface()
    await textTab.click()
    await expect(owner.getByRole('heading', { name: '发送文本' })).toBeVisible()
    const textSurface = await measureRoomSurface()
    expect(Math.abs(fileSurface.documentHeight - textSurface.documentHeight)).toBeLessThanOrEqual(2)
    expect(Math.abs(fileSurface.scrollY - textSurface.scrollY)).toBeLessThanOrEqual(2)
    expect(Math.abs(fileSurface.footerTop - textSurface.footerTop)).toBeLessThanOrEqual(2)
    expect(Math.abs(fileSurface.layoutTop - textSurface.layoutTop)).toBeLessThanOrEqual(2)
    expect(Math.abs(textSurface.footerLeft - textSurface.layoutLeft)).toBeLessThanOrEqual(1)
    expect(Math.abs(textSurface.footerRight - textSurface.layoutRight)).toBeLessThanOrEqual(1)
    await owner.getByRole('tab', { name: '文件' }).click()
    await expect(owner.getByRole('heading', { name: '选择要发送的文件' })).toBeVisible()
    await expect(roomFooter).toHaveCount(1)

    await receiver.evaluate(() => window.dispatchEvent(new Event('offline')))
    await expect(receiver.getByText('网络已断开，恢复后会自动重新连接')).toBeVisible()
    await receiverContext.setOffline(true)
    await receiver.waitForTimeout(750)
    await receiverContext.setOffline(false)
    await expect(receiver.getByText('连接已恢复')).toBeVisible()
    await expect(receiver.getByRole('heading', { name: '等待对方发送' })).toBeVisible({ timeout: peerReadyTimeout })

    if (process.env.CAPTURE_ROOM === '1') {
      const outputDirectory = resolve(currentDirectory, '../docs/release/screenshots')
      await mkdir(outputDirectory, { recursive: true })
      await owner.screenshot({
        path: resolve(outputDirectory, `m5-room-owner-${test.info().project.name}.png`),
        fullPage: true,
      })
      await receiver.screenshot({
        path: resolve(outputDirectory, `m5-room-receiver-${test.info().project.name}.png`),
        fullPage: true,
      })
    }

    await receiver.reload()
    await expect(receiver.getByRole('heading', { name: '等待对方发送' })).toBeVisible({ timeout: peerReadyTimeout })
    await expect(receiver.locator('html')).not.toHaveAttribute('data-p2p-room-restore', /.+/u)

    await owner.reload()
    await expect(owner.getByRole('heading', { name: '选择要发送的文件' })).toBeVisible({ timeout: peerReadyTimeout })
    await expect(owner.getByText('房间已创建，可以复制邀请链接', { exact: true })).toBeVisible()
    await expect(owner.locator('html')).not.toHaveAttribute('data-p2p-room-restore', /.+/u)
  } finally {
    await receiverContext.close()
    await ownerContext.close()
  }
})

test('room code copy uses the real clipboard permission path', async ({
  context,
  page,
  baseURL,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'real clipboard permissions are validated in Chromium')
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: baseURL })
  await page.goto('/')
  await page.getByRole('button', { name: '创建房间' }).click()

  const roomCodeButton = page.getByRole('button', { name: /复制房间码/ })
  const roomCode = (await roomCodeButton.textContent())?.trim() ?? ''
  await roomCodeButton.click()
  await expect(page.getByText('房间码已复制', { exact: true })).toBeVisible()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(roomCode)
})

test('room code copy reports a recovery action when browser copy is unavailable', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async () => { throw new Error('clipboard denied') } },
    })
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: () => false,
    })
  })
  await page.goto('/')
  await page.getByRole('button', { name: '创建房间' }).click()
  await page.getByRole('button', { name: /复制房间码/ }).click()
  await expect(page.getByText('无法复制房间码，请手动选择后复制', { exact: true })).toBeVisible()
})

test('a receiver can enter a room code in one field, submit with Enter, and cancel', { tag: '@smoke' }, async ({ browser, baseURL }) => {
  const ownerContext = await browser.newContext({ baseURL })
  const receiverContext = await browser.newContext({ baseURL })
  const owner = await ownerContext.newPage()
  const receiver = await receiverContext.newPage()

  try {
    await owner.goto('/')
    await owner.getByRole('button', { name: '创建房间' }).click()
    const roomCode = (await owner.getByRole('button', { name: /复制房间码/ }).textContent())?.trim()
    expect(roomCode).toMatch(/^[A-Z2-9]{6}$/)

    await receiver.goto('/')
    const input = await enterRoomCode(receiver, roomCode ?? '')
    await expect(input).toHaveValue(roomCode ?? '')
    await expect(input).toBeFocused()
    await receiver.keyboard.press('Enter')
    await expect(owner.getByRole('dialog', { name: '加入申请' })).toBeVisible()

    await receiver.getByRole('button', { name: '更换房间' }).click()
    await expect(receiver.getByRole('heading', { name: '加入房间' })).toBeVisible()
    await expect(owner.getByRole('dialog', { name: '加入申请' })).toBeHidden()
  } finally {
    await receiverContext.close()
    await ownerContext.close()
  }
})
