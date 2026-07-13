import { expect, test } from '@playwright/test'
import { fillRoomCode, roomCodeFromPage } from './fixtures'

test('two real browser contexts can approve a peer and transfer text and a file', async ({ browser, baseURL }) => {
  const sender = await browser.newContext({ baseURL })
  const receiver = await browser.newContext({ baseURL })

  try {
    const senderPage = await sender.newPage()
    const receiverPage = await receiver.newPage()

    await senderPage.goto('/')

    const aboutDialog = senderPage.getByRole('dialog', {
      name: '关于 P2P Transmission',
      exact: true,
    })
    const lobbyAboutButton = senderPage.getByRole('button', {
      name: '关于 P2P Transmission',
      exact: true,
    })

    await lobbyAboutButton.click()
    await expect(aboutDialog).toBeVisible()
    await expect(aboutDialog.getByRole('heading', {
      name: '关于 P2P Transmission',
      exact: true,
    })).toBeVisible()
    await expect(aboutDialog).toContainText('https://p2p.yxswy.com')
    await expect(aboutDialog).toContainText('30 分钟')
    await expect(aboutDialog).toContainText('10 个文件')
    await expect(aboutDialog).toContainText('100 MiB')
    await aboutDialog.getByRole('button', { name: '关闭', exact: true }).click()
    await expect(aboutDialog).toBeHidden()

    await senderPage.getByRole('button', { name: '创建房间' }).click()
    await expect(senderPage.getByRole('button', { name: '复制房间码' })).toBeVisible()

    const roomAboutButton = senderPage.getByRole('button', {
      name: '关于 P2P Transmission',
      exact: true,
    })
    await roomAboutButton.click()
    await expect(aboutDialog).toBeVisible()
    await expect(aboutDialog.getByRole('heading', {
      name: '关于 P2P Transmission',
      exact: true,
    })).toBeVisible()
    await expect(aboutDialog).toContainText('https://p2p.yxswy.com')
    await expect(aboutDialog).toContainText('30 分钟')
    await expect(aboutDialog).toContainText('10 个文件')
    await expect(aboutDialog).toContainText('100 MiB')
    await aboutDialog.getByRole('button', { name: '关闭', exact: true }).click()
    await expect(aboutDialog).toBeHidden()

    const code = await roomCodeFromPage(senderPage)

    await receiverPage.goto('/')
    await fillRoomCode(receiverPage, code)
    await receiverPage.getByRole('button', { name: '请求加入' }).click()
    await expect(receiverPage.getByRole('heading', { name: '等待发送者确认' })).toBeVisible()

    const joinDialog = senderPage.getByRole('dialog', { name: '加入申请' })
    await expect(joinDialog).toBeVisible()
    await joinDialog.getByRole('button', { name: '允许加入' }).click()

    await expect(senderPage.getByText('1 位接收者已连接')).toBeVisible({ timeout: 30_000 })
    await expect(receiverPage.getByRole('heading', { name: '等待对方发送' })).toBeVisible({ timeout: 30_000 })

    const text = `真实浏览器 E2E ${Date.now()}`
    await senderPage.getByRole('textbox', { name: '要传输的文本' }).fill(text)
    await senderPage.getByRole('button', { name: '发送给 1 位接收者' }).click()

    const textDialog = receiverPage.getByRole('dialog', { name: '收到文本' })
    await expect(textDialog).toContainText(text, { timeout: 30_000 })
    await textDialog.getByRole('button', { name: '关闭' }).click()
    await senderPage.getByRole('button', { name: '关闭结果' }).click()

    await senderPage.getByRole('tab', { name: '传输文件' }).click()
    await senderPage.locator('input[type="file"]').setInputFiles({
      name: 'e2e.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('真实浏览器文件传输'),
    })
    await senderPage.getByRole('button', { name: '发送 1 个文件' }).click()

    const fileDialog = receiverPage.getByRole('dialog', { name: '收到文件' })
    await expect(fileDialog.getByRole('button', { name: '接收全部' })).toBeVisible({ timeout: 30_000 })
    await fileDialog.getByRole('button', { name: '接收全部' }).click()
    await expect(fileDialog.getByRole('button', { name: '一键下载' })).toBeVisible({ timeout: 30_000 })
    await expect(fileDialog).toContainText('e2e.txt')
  } finally {
    await receiver.close()
    await sender.close()
  }
})

test('sender can target one receiver, then broadcast to both', async ({ browser, baseURL }) => {
  const sender = await browser.newContext({ baseURL })
  const firstReceiver = await browser.newContext({ baseURL })
  const secondReceiver = await browser.newContext({ baseURL })

  try {
    const senderPage = await sender.newPage()
    const firstReceiverPage = await firstReceiver.newPage()
    const secondReceiverPage = await secondReceiver.newPage()

    await senderPage.goto('/')
    await senderPage.getByRole('button', { name: '创建房间' }).click()
    await expect(senderPage.getByRole('button', { name: '复制房间码' })).toBeVisible()
    const code = await roomCodeFromPage(senderPage)

    for (const page of [firstReceiverPage, secondReceiverPage]) {
      await page.goto('/')
      await fillRoomCode(page, code)
      await page.getByRole('button', { name: '请求加入' }).click()
      await expect(page.getByRole('heading', { name: '等待发送者确认' })).toBeVisible()
    }

    for (let index = 0; index < 2; index += 1) {
      const joinDialog = senderPage.getByRole('dialog', { name: '加入申请' })
      await expect(joinDialog).toBeVisible()
      await joinDialog.getByRole('button', { name: '允许加入' }).click()
    }

    await expect(senderPage.getByText('2 位接收者已连接')).toBeVisible({ timeout: 30_000 })

    const pickerTrigger = senderPage.getByRole('button', {
      name: '选择接收者，已选择 2 位',
    })
    await pickerTrigger.click()
    const picker = senderPage.getByRole('dialog', { name: '选择接收者' })
    await expect(picker).toBeVisible()
    await picker.locator('label').nth(1).click()
    await picker.getByRole('button', { name: '确定' }).click()

    const text = `定向文本 ${Date.now()}`
    await senderPage.getByRole('textbox', { name: '要传输的文本' }).fill(text)
    await senderPage.getByRole('button', { name: '发送给 1 位接收者' }).click()
    const firstTextDialog = firstReceiverPage.getByRole('dialog', { name: '收到文本' })
    await expect(firstTextDialog).toContainText(text, { timeout: 30_000 })
    await expect(secondReceiverPage.getByRole('dialog', { name: '收到文本' })).toHaveCount(0)
    await firstTextDialog.getByRole('button', { name: '关闭' }).click()

    await expect(senderPage.getByRole('button', { name: '关闭结果' })).toBeVisible({ timeout: 30_000 })
    await senderPage.getByRole('button', { name: '关闭结果' }).click()
    await senderPage.getByRole('button', {
      name: '选择接收者，已选择 1 位',
    }).click()
    const secondPicker = senderPage.getByRole('dialog', { name: '选择接收者' })
    await secondPicker.locator('label').nth(1).click()
    await secondPicker.getByRole('button', { name: '确定' }).click()

    await senderPage.getByRole('tab', { name: '传输文件' }).click()
    await senderPage.locator('input[type="file"]').setInputFiles({
      name: 'broadcast.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('广播文件传输'),
    })
    await senderPage.getByRole('button', { name: '发送 1 个文件' }).click()

    await expect(firstReceiverPage.getByRole('dialog', { name: '收到文件' })
      .getByRole('button', { name: '接收全部' })).toBeVisible({ timeout: 30_000 })
    await expect(secondReceiverPage.getByRole('dialog', { name: '收到文件' })
      .getByRole('button', { name: '接收全部' })).toBeVisible({ timeout: 30_000 })
  } finally {
    await secondReceiver.close()
    await firstReceiver.close()
    await sender.close()
  }
})
