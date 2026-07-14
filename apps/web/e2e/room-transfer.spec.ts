import { expect, test } from '@playwright/test'
import { fillRoomCode, roomCodeFromPage } from './fixtures'

const clipboardPermissions = ['clipboard-read', 'clipboard-write'] as const

test('two real browser contexts can approve a peer and transfer a pasted text file', async ({ browser, baseURL }) => {
  const sender = await browser.newContext({ baseURL, permissions: [...clipboardPermissions] })
  const receiver = await browser.newContext({ baseURL, permissions: [...clipboardPermissions] })

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

    const code = await roomCodeFromPage(senderPage)

    await receiverPage.goto('/')
    await fillRoomCode(receiverPage, code)
    await receiverPage.getByRole('button', { name: '请求加入' }).click()
    await expect(receiverPage.getByRole('heading', { name: '等待发送者确认' })).toBeVisible()

    const joinDialog = senderPage.getByRole('dialog', { name: '加入申请' })
    await expect(joinDialog).toBeVisible()
    await joinDialog.getByRole('button', { name: '允许加入' }).click()

    await expect(senderPage.getByRole('status', { name: '1 位接收者已连接' })).toBeVisible({ timeout: 30_000 })
    await expect(receiverPage.getByRole('heading', { name: '等待对方发送' })).toBeVisible({ timeout: 30_000 })

    const text = `真实浏览器 E2E 粘贴文本 ${Date.now()}`
    await senderPage.evaluate(async value => {
      await navigator.clipboard.writeText(value)
    }, text)

    const uploadArea = senderPage.getByRole('button', { name: '上传要传输的内容' })
    await uploadArea.focus()
    await uploadArea.press('Control+V')

    const pasteDialog = senderPage.getByRole('dialog', { name: '确认添加粘贴内容' })
    await expect(pasteDialog).toBeVisible()
    await pasteDialog.getByRole('button', { name: '添加到传输列表' }).click()
    await expect(uploadArea.getByText('粘贴内容.txt', { exact: true })).toBeVisible()
    await senderPage.getByRole('button', { name: '发送 1 项', exact: true }).click()

    const fileDialog = receiverPage.getByRole('dialog', { name: '收到文件' })
    await expect(fileDialog.getByRole('button', { name: '接收全部' })).toBeVisible({ timeout: 30_000 })
    await fileDialog.getByRole('button', { name: '接收全部' }).click()
    const copyButton = fileDialog.getByRole('button', { name: '复制粘贴内容.txt 的内容' })
    await expect(copyButton).toBeVisible({ timeout: 30_000 })
    await expect(fileDialog.getByRole('link', { name: '下载 粘贴内容.txt' })).toBeVisible()
    await copyButton.click()
    await expect(copyButton).toHaveAttribute('aria-label', '已复制粘贴内容.txt 的内容')
    await expect.poll(
      () => receiverPage.evaluate(() => navigator.clipboard.readText()),
      { timeout: 15_000 },
    ).toBe(text)
  } finally {
    await receiver.close()
    await sender.close()
  }
})

test('sender confirms or cancels a pasted clipboard file', async ({ browser, baseURL }) => {
  const sender = await browser.newContext({ baseURL, permissions: [...clipboardPermissions] })

  try {
    const senderPage = await sender.newPage()
    await senderPage.goto('/')
    await senderPage.getByRole('button', { name: '创建房间' }).click()

    const uploadArea = senderPage.getByRole('button', { name: '上传要传输的内容' })
    await expect(uploadArea).toBeVisible()

    const dispatchClipboardFile = async () => {
      await uploadArea.evaluate(element => {
        const dataTransfer = new DataTransfer()
        const file = new File(['真实浏览器剪贴板文件事件'], 'clipboard-event.txt', {
          type: 'text/plain',
        })
        dataTransfer.items.add(file)
        const event = new ClipboardEvent('paste', {
          bubbles: true,
          cancelable: true,
          clipboardData: dataTransfer,
        })
        element.dispatchEvent(event)
      })
    }

    await uploadArea.focus()
    await dispatchClipboardFile()
    const firstPasteDialog = senderPage.getByRole('dialog', { name: '确认添加粘贴内容' })
    await expect(firstPasteDialog).toBeVisible()
    await firstPasteDialog.getByRole('button', { name: '取消' }).click()
    await expect(senderPage.getByText('clipboard-event.txt', { exact: true })).toHaveCount(0)

    await uploadArea.focus()
    await dispatchClipboardFile()
    const secondPasteDialog = senderPage.getByRole('dialog', { name: '确认添加粘贴内容' })
    await expect(secondPasteDialog).toBeVisible()
    await secondPasteDialog.getByRole('button', { name: '添加到传输列表' }).click()
    await expect(uploadArea.getByText('clipboard-event.txt', { exact: true })).toBeVisible()
  } finally {
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

    await expect(senderPage.getByRole('status', { name: '2 位接收者已连接' })).toBeVisible({ timeout: 30_000 })

    const pickerTrigger = senderPage.getByRole('button', {
      name: '选择接收者，已选择 2 位',
    })
    await pickerTrigger.click()
    const picker = senderPage.getByRole('dialog', { name: '选择接收者' })
    await expect(picker).toBeVisible()
    await picker.locator('label').nth(1).click()
    await picker.getByRole('button', { name: '确定' }).click()

    await senderPage.locator('input[type="file"]').setInputFiles({
      name: 'targeted.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('定向文件传输'),
    })
    await senderPage.getByRole('button', { name: '发送 1 项', exact: true }).click()
    const firstFileDialog = firstReceiverPage.getByRole('dialog', { name: '收到文件' })
    await expect(firstFileDialog.getByRole('button', { name: '接收全部' })).toBeVisible({ timeout: 30_000 })
    await firstFileDialog.getByRole('button', { name: '接收全部' }).click()
    await expect(firstFileDialog.getByRole('link', { name: '下载 targeted.txt' })).toBeVisible({ timeout: 30_000 })
    await expect(secondReceiverPage.getByRole('dialog', { name: '收到文件' })).toHaveCount(0)
    await firstFileDialog.getByRole('button', { name: '关闭' }).click()

    await expect(senderPage.getByRole('button', { name: '关闭结果' })).toBeVisible({ timeout: 30_000 })
    await senderPage.getByRole('button', { name: '关闭结果' }).click()
    await senderPage.getByRole('button', {
      name: '选择接收者，已选择 1 位',
    }).click()
    const secondPicker = senderPage.getByRole('dialog', { name: '选择接收者' })
    await secondPicker.locator('label').nth(1).click()
    await secondPicker.getByRole('button', { name: '确定' }).click()

    await senderPage.getByRole('button', { name: '清空' }).click()
    await senderPage.locator('input[type="file"]').setInputFiles({
      name: 'broadcast.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('广播文件传输'),
    })
    await senderPage.getByRole('button', { name: '发送 1 项', exact: true }).click()

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
