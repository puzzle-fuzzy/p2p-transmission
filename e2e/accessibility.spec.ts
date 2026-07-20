import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { Buffer } from 'node:buffer'

import { approveRoomJoin, createRoom, requestRoomJoin } from './room.helper'
import { useFileInputFallback } from './transfer.helper'

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

async function expectMinimumTouchTarget(locator: Locator) {
  const box = await locator.boundingBox()
  expect(box).not.toBeNull()
  expect(box!.width).toBeGreaterThanOrEqual(44)
  expect(box!.height).toBeGreaterThanOrEqual(44)
}

test('the root transfer workspace passes WCAG axe rules', { tag: '@smoke' }, async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: '加入房间' })).toBeVisible()
  await expectNoAccessibilityViolations(page)

  const aboutTrigger = page.getByRole('button', { name: '关于', exact: true })
  await aboutTrigger.click()
  const aboutDialog = page.getByRole('dialog', { name: '关于', exact: true })
  await expect(aboutDialog).toBeVisible()
  await expect(aboutDialog).toContainText('文件和文本正文通过加密的 WebRTC 通道传输')
  await expect(aboutDialog).toHaveCSS('opacity', '1')
  await expectNoAccessibilityViolations(page)
  await page.keyboard.press('Escape')
  await expect(aboutDialog).toBeHidden()
  await expect(aboutTrigger).toBeFocused()
})

test('dynamic room and transfer states pass WCAG axe rules', async ({
  baseURL,
  browser,
}, testInfo) => {
  const mobile = testInfo.project.name === 'mobile-chromium'
  const contextOptions = {
    baseURL,
    viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 960 },
    isMobile: mobile,
    hasTouch: mobile,
  }
  const ownerContext = await browser.newContext(contextOptions)
  const receiverContext = await browser.newContext(contextOptions)
  const owner = await ownerContext.newPage()
  const receiver = await receiverContext.newPage()
  await useFileInputFallback(owner)

  try {
    const roomCode = await createRoom(owner)
    await requestRoomJoin(receiver, roomCode)

    await expect(receiver.getByRole('heading', { name: '等待发送者确认' })).toBeVisible()
    await expect(receiver.getByRole('status')).toContainText('等待确认')
    await expectNoAccessibilityViolations(receiver)

    const requestDialog = owner.getByRole('dialog', { name: '加入申请' })
    await expect(requestDialog).toBeVisible()
    await expectNoAccessibilityViolations(owner)

    const decisionRoute = '**/api/rooms/*/join-requests/*/decision'
    const approveButton = requestDialog.getByRole('button', { name: '允许加入' })
    const rejectButton = requestDialog.getByRole('button', { name: '拒绝' })
    await owner.route(decisionRoute, route => route.abort())
    await approveButton.click()
    await expect(requestDialog.getByRole('alert')).toHaveText(
      '网络连接失败，请检查网络后重试',
    )
    await expect(approveButton).toBeEnabled()
    await expect(rejectButton).toBeEnabled()
    await owner.unroute(decisionRoute)

    await approveRoomJoin(owner)
    await expect(owner.getByRole('status', { name: '1 位接收者已连接' })).toBeVisible()
    await expect(owner.getByRole('heading', { name: '选择要发送的文件' })).toBeVisible({
      timeout: 20_000,
    })
    const ownerTransferRegion = owner.getByRole('region', { name: '文件与文本传输' })
    const ownerTransferStatus = ownerTransferRegion.getByRole('status')
    await expect(ownerTransferStatus).toHaveAttribute('aria-live', 'polite')
    await expect(ownerTransferStatus).toHaveAttribute('aria-atomic', 'true')
    await expect(ownerTransferStatus).toContainText('选择要发送的文件')
    await expect(receiver.getByRole('heading', { name: '等待对方发送' })).toBeVisible({
      timeout: 20_000,
    })
    await expectNoAccessibilityViolations(owner)

    await owner.getByRole('button', { name: '选择接收者，已选择 1 位' }).click()
    const recipientDialog = owner.getByRole('dialog', { name: '选择接收者' })
    await expect(recipientDialog).toBeVisible()
    const selectedCountStatus = recipientDialog.getByRole('status')
    await expect(selectedCountStatus).toHaveText('已选 1 人')
    await expect(selectedCountStatus).toHaveAttribute('aria-live', 'polite')
    await expect(selectedCountStatus).toHaveAttribute('aria-atomic', 'true')
    await recipientDialog.getByRole('button', { name: '清空选择' }).click()
    await expect(selectedCountStatus).toHaveText('已选 0 人')
    await recipientDialog.getByRole('button', { name: '全选' }).click()
    await expect(selectedCountStatus).toHaveText('已选 1 人')
    await expectNoAccessibilityViolations(owner)
    await recipientDialog.getByRole('button', { name: '取消' }).click()
    await expect(recipientDialog).toBeHidden()

    await owner.locator('#transfer-file-input').setInputFiles({
      name: 'a11y-empty.txt',
      mimeType: 'text/plain',
      buffer: Buffer.alloc(0),
    })
    const transferDialog = receiver.getByRole('dialog', { name: '接收文件' })
    await expect(transferDialog).toBeVisible()
    await expect(transferDialog).toContainText('a11y-empty.txt')
    await expectNoAccessibilityViolations(receiver)

    await transferDialog.getByRole('button', { name: '接收文件' }).click()
    await expect(owner.getByRole('heading', { name: '文件发送完成' })).toBeVisible()
    await expect(receiver.getByRole('heading', { name: '文件接收完成' })).toBeVisible()
    await expect(ownerTransferStatus).toContainText('文件发送完成')
    const completedProgress = owner.getByRole('progressbar', {
      name: 'a11y-empty.txt 传输进度',
    })
    await expect(completedProgress).toHaveAttribute('aria-valuetext', '全部传输完成')
    await expect(
      completedProgress.locator('xpath=..').getByText('全部传输完成', { exact: true }),
    ).toBeVisible()
    await expectNoAccessibilityViolations(owner)
    await expectNoAccessibilityViolations(receiver)

    await owner.getByRole('tab', { name: '文本' }).click()
    await owner.getByRole('textbox', { name: '文本内容' }).fill('无障碍文本\n第二行')
    await expectNoAccessibilityViolations(owner)
    await owner.getByRole('button', { name: '发送文本' }).click()
    await expect(receiver.getByRole('dialog', { name: '接收文本' })).toHaveCount(0)
    await expect(receiver.getByRole('heading', { name: '文本接收完成' })).toBeVisible()
    await expect(owner.getByLabel('文本发送状态').getByText('已送达')).toBeVisible()
    await expectNoAccessibilityViolations(owner)
    await expectNoAccessibilityViolations(receiver)
  } finally {
    await receiverContext.close()
    await ownerContext.close()
  }
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
    await expect(page.getByRole('heading', { name: '加入房间' })).toBeVisible()
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '200%'
    })
    const roomCode = page.getByRole('textbox', { name: '输入 6 位房间码' })
    const createRoomButton = page.getByRole('button', { name: '创建房间' })
    const requestJoinButton = page.getByRole('button', { name: '请求加入' })
    await expect(roomCode).toBeVisible()
    await expect(createRoomButton).toBeVisible()
    await expect(requestJoinButton).toBeVisible()
    await expectMinimumTouchTarget(roomCode)
    await expectMinimumTouchTarget(createRoomButton)
    await expectMinimumTouchTarget(requestJoinButton)
    await roomCode.focus()
    expect(await roomCode.evaluate(element => {
      const style = getComputedStyle(element)
      const visibleOutline = style.outlineStyle !== 'none'
        && Number.parseFloat(style.outlineWidth) >= 2
      const visibleBorder = style.borderStyle !== 'none'
        && Number.parseFloat(style.borderWidth) >= 2
      return visibleOutline || visibleBorder
    })).toBe(true)
    await expectNoHorizontalOverflow(page)
  } finally {
    await context.close()
  }
})
