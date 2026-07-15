import { expect, test } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const currentDirectory = dirname(fileURLToPath(import.meta.url))

test('two browsers can create, approve, connect, and restore a Rust 2.0 room', async ({
  browser,
  baseURL,
}) => {
    const ownerContext = await browser.newContext({ baseURL })
    const receiverContext = await browser.newContext({ baseURL })
    const owner = await ownerContext.newPage()
    const receiver = await receiverContext.newPage()

  try {
    await owner.goto('/')
    await owner.getByRole('button', { name: '创建房间' }).click()
    await expect(owner.getByText('发送者', { exact: true })).toBeVisible()
    const roomCodeButton = owner.getByRole('button', { name: /复制房间码/ })
    await expect(roomCodeButton).toBeVisible()
    const roomCode = (await roomCodeButton.textContent())?.trim() ?? ''
    expect(roomCode).toMatch(/^[A-Z2-9]{6}$/)

    const shareButton = owner.getByRole('button', { name: '分享房间' })
    await shareButton.click()
    const shareDialog = owner.getByRole('dialog', { name: '分享房间' })
    await expect(shareDialog).toBeVisible()
    await expect(shareDialog).toContainText(roomCode)
    await owner.keyboard.press('Escape')
    await expect(shareDialog).toBeHidden()
    await expect(shareButton).toBeFocused()

    await shareButton.click()
    await shareDialog.getByRole('button', { name: '关闭' }).click()
    await expect(shareDialog).toBeHidden()

    await receiver.goto('/')
    await receiver.getByRole('textbox', { name: '输入 6 位房间码' }).fill(roomCode)
    await receiver.getByRole('button', { name: '请求加入' }).click()
    await expect(receiver.getByRole('heading', { name: '等待发送者确认' })).toBeVisible()
    await expect(receiver.getByRole('status')).toContainText('等待确认')

    const requestDialog = owner.getByRole('dialog', { name: '加入申请' })
    await expect(requestDialog).toBeVisible()
    await owner.keyboard.press('Escape')
    await expect(requestDialog).toBeVisible()
    await requestDialog.getByRole('button', { name: '允许加入' }).click()

    await expect(receiver.getByText('接收者', { exact: true })).toBeVisible()
    const enteringAvatar = owner.locator('.avatar-entering')
    await expect(enteringAvatar).toHaveCount(1)
    await expect.poll(async () => enteringAvatar.evaluate(element => (
      getComputedStyle(element).animationName
    ))).toBe('receiver-avatar-enter')
    await expect(enteringAvatar).toHaveCount(0, { timeout: 2_000 })
    await expect(receiver.getByRole('heading', { name: '等待对方发送' })).toBeVisible()
    await expect(owner.getByRole('heading', { name: '选择要发送的文件' })).toBeVisible()

    await receiver.evaluate(() => window.dispatchEvent(new Event('offline')))
    await expect(receiver.getByText('网络已断开，恢复后会自动重新连接')).toBeVisible()
    await receiverContext.setOffline(true)
    await receiver.waitForTimeout(750)
    await receiverContext.setOffline(false)
    await expect(receiver.getByText('连接已恢复')).toBeVisible()
    await expect(receiver.getByRole('heading', { name: '等待对方发送' })).toBeVisible()

    if (process.env.CAPTURE_V2_ROOM === '1') {
      const outputDirectory = resolve(currentDirectory, '../../../docs/rust-v2/screenshots')
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
    await expect(receiver.getByRole('heading', { name: '等待对方发送' })).toBeVisible()

    await owner.reload()
    await expect(owner.getByText('发送者', { exact: true })).toBeVisible()
    await expect(owner.getByRole('heading', { name: '选择要发送的文件' })).toBeVisible()
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
