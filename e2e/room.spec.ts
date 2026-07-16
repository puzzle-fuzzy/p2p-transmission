import { expect, test } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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
        sharedInvite: null as ShareData | null,
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
      Object.defineProperty(navigator, 'share', {
        configurable: true,
        value: async (data: ShareData) => {
          state.sharedInvite = data
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
    await expect(owner.getByText('发送者', { exact: true })).toBeVisible()
    const roomCodeButton = owner.getByRole('button', { name: /复制房间码/ })
    await expect(roomCodeButton).toBeVisible()
    const roomCode = (await roomCodeButton.textContent())?.trim() ?? ''
    expect(roomCode).toMatch(/^[A-Z2-9]{6}$/)
    await expect(owner.getByText('房间已创建，可以分享邀请链接', { exact: true })).toBeVisible()

    const ownerPeerFlow = owner.locator('.peer-flow')
    await expect(ownerPeerFlow.locator('.avatar')).toHaveCount(1)
    await expect(ownerPeerFlow.locator('.peer-track')).toHaveCount(0)
    await expect(ownerPeerFlow.locator('.receiver-side')).toHaveCount(0)
    await expect(owner.locator('.receiver-placeholder')).toHaveCount(0)
    await expect(owner.locator('.leave-button .leave-icon')).toBeVisible()

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
    await shareDialog.getByRole('button', { name: '分享邀请链接' }).click()
    await expect(shareDialog).toBeHidden()
    await expect(owner.getByText('邀请链接已分享', { exact: true })).toBeVisible()
    const sharedInvite = await owner.evaluate(() => (
      window as unknown as {
        __browserCapabilityState: { sharedInvite: ShareData | null }
      }
    ).__browserCapabilityState.sharedInvite)
    expect(sharedInvite?.url).toContain(`#room=${roomCode}&capability=`)
    expect(new URL(sharedInvite?.url ?? 'http://invalid/').pathname).toBe('/')

    await receiver.goto(`/?room=${roomCode}`)
    await expect(receiver.getByRole('heading', { name: '等待发送者确认' })).toBeVisible()
    await expect(receiver.getByRole('status')).toContainText('等待确认')

    const requestDialog = owner.getByRole('dialog', { name: '加入申请' })
    await expect(requestDialog).toBeVisible()
    await owner.keyboard.press('Escape')
    await expect(requestDialog).toBeVisible()
    await requestDialog.getByRole('button', { name: '允许加入' }).click()

    await expect(receiver.getByText('接收者', { exact: true })).toBeVisible()
    await expect(ownerPeerFlow.locator('.peer-track')).toBeVisible()
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
    await expect(receiver.getByText('接收者', { exact: true })).toBeVisible()
    await expect(receiver.getByRole('heading', { name: '等待对方发送' })).toBeVisible({ timeout: peerReadyTimeout })

    await owner.reload()
    await expect(owner.getByText('发送者', { exact: true })).toBeVisible()
    await expect(owner.getByRole('heading', { name: '选择要发送的文件' })).toBeVisible({ timeout: peerReadyTimeout })
    await expect(owner.getByText('房间已创建，可以分享邀请链接', { exact: true })).toBeVisible()
    await expect(owner.locator('.avatar-entering')).toHaveCount(0)
  } finally {
    await receiverContext.close()
    await ownerContext.close()
  }
})

test('a receiver can cancel a pending join request', async ({ browser, baseURL }) => {
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
    await receiver.getByRole('textbox', { name: '输入 6 位房间码' }).fill(roomCode ?? '')
    await receiver.getByRole('button', { name: '请求加入' }).click()
    await expect(owner.getByRole('dialog', { name: '加入申请' })).toBeVisible()

    await receiver.getByRole('button', { name: '更换房间' }).click()
    await expect(receiver.getByRole('heading', { name: '加入房间' })).toBeVisible()
    await expect(owner.getByRole('dialog', { name: '加入申请' })).toBeHidden()
  } finally {
    await receiverContext.close()
    await ownerContext.close()
  }
})
