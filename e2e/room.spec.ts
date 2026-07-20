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
}) => {
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

  try {
    await owner.goto('/')
    await owner.getByRole('button', { name: '创建房间' }).click()
    await expect.poll(() => owner.evaluate(() => (
      window as unknown as {
        __browserCapabilityState: { notificationPermissionRequests: number }
      }
    ).__browserCapabilityState.notificationPermissionRequests)).toBe(1)
    await expect(owner.locator('.member-row').filter({ hasText: '（你）' })).toBeVisible()
    const roomCodeButton = owner.getByRole('button', { name: /复制房间码/ })
    await expect(roomCodeButton).toBeVisible()
    const roomCode = (await roomCodeButton.textContent())?.trim() ?? ''
    expect(roomCode).toMatch(/^[A-Z2-9]{6}$/)
    await expect(owner.getByText('房间已创建，可以复制邀请链接', { exact: true })).toBeVisible()

    const ownerPeerFlow = owner.locator('.peer-flow')
    await expect(ownerPeerFlow.locator('.avatar')).toHaveCount(1)
    await expect(ownerPeerFlow.locator('.peer-track')).toHaveCount(0)
    await expect(ownerPeerFlow.locator('.receiver-side')).toHaveCount(0)
    await expect(owner.locator('.receiver-placeholder')).toHaveCount(0)
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
      const cardRect = waiting.closest('.vault-card')?.getBoundingClientRect()
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
    )).toBeLessThanOrEqual(1)

    const requestDialog = owner.getByRole('dialog', { name: '加入申请' })
    await expect(requestDialog).toBeVisible()
    await owner.keyboard.press('Escape')
    await expect(requestDialog).toBeVisible()
    await requestDialog.getByRole('button', { name: '允许加入' }).click()

    await expect(receiver.locator('.member-row').filter({ hasText: '（你）' })).toBeVisible()
    await expect(ownerPeerFlow.locator('.peer-track')).toHaveClass(/connected/u)
    await expect(ownerPeerFlow.locator('.peer-track')).toBeHidden()
    await expect(ownerPeerFlow.locator('.receiver-side .avatar')).toHaveCount(1)
    const enteringAvatar = owner.locator('.avatar-entering')
    await expect(enteringAvatar).toHaveCount(1)
    await expect.poll(async () => enteringAvatar.evaluate(element => (
      getComputedStyle(element).animationName
    ))).toBe('receiver-avatar-enter')
    await expect(enteringAvatar).toHaveCount(0, { timeout: 2_000 })
    await expect(receiver.getByRole('heading', { name: '等待对方发送' })).toBeVisible({ timeout: peerReadyTimeout })
    await expect(owner.getByRole('heading', { name: '选择要发送的文件' })).toBeVisible({ timeout: peerReadyTimeout })

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
    await expect(receiver.locator('.member-row').filter({ hasText: '（你）' })).toBeVisible()
    await expect(receiver.getByRole('heading', { name: '等待对方发送' })).toBeVisible({ timeout: peerReadyTimeout })
    await expect(receiver.locator('html')).not.toHaveAttribute('data-p2p-room-restore', /.+/u)

    await owner.reload()
    await expect(owner.locator('.member-row').filter({ hasText: '（你）' })).toBeVisible()
    await expect(owner.getByRole('heading', { name: '选择要发送的文件' })).toBeVisible({ timeout: peerReadyTimeout })
    await expect(owner.getByText('房间已创建，可以复制邀请链接', { exact: true })).toBeVisible()
    await expect(owner.locator('.avatar-entering')).toHaveCount(0)
    await expect(owner.locator('html')).not.toHaveAttribute('data-p2p-room-restore', /.+/u)
  } finally {
    await receiverContext.close()
    await ownerContext.close()
  }
})

test('a receiver can enter a room code one cell at a time, submit with Enter, and cancel', { tag: '@smoke' }, async ({ browser, baseURL }) => {
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
    const inputs = await enterRoomCode(receiver, roomCode ?? '')
    expect(await inputs.evaluateAll(roomCodeInputs => roomCodeInputs.map(input => (
      (input as HTMLInputElement).value
    )))).toEqual(Array.from(roomCode ?? ''))
    await expect(inputs.last()).toBeFocused()
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
