import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { fillRoomCode, roomCodeFromPage } from './fixtures'

const repositoryRoot = resolve(import.meta.dirname, '../../..')
const screenshotRoot = join(
  repositoryRoot,
  'docs/product-baseline/screenshots',
)

const capture = async (page: Page, name: string) => {
  await page.screenshot({
    animations: 'disabled',
    fullPage: true,
    path: join(screenshotRoot, `${name}.png`),
  })
}

test.describe('1.x product experience baseline', () => {
  test.skip(
    process.env.CAPTURE_V1_BASELINE !== '1',
    'Set CAPTURE_V1_BASELINE=1 to refresh checked-in product screenshots.',
  )

  test('captures responsive and two-peer product states', async ({
    browser,
    baseURL,
  }) => {
    await mkdir(screenshotRoot, { recursive: true })

    const sender = await browser.newContext({
      baseURL,
      permissions: ['clipboard-read', 'clipboard-write'],
      viewport: { width: 1_440, height: 1_000 },
    })
    const receiver = await browser.newContext({
      baseURL,
      viewport: { width: 390, height: 844 },
    })

    try {
      const senderPage = await sender.newPage()
      const receiverPage = await receiver.newPage()

      await senderPage.goto('/')
      await capture(senderPage, 'home-1440')

      await senderPage.setViewportSize({ width: 768, height: 1_024 })
      await capture(senderPage, 'home-768')

      await senderPage.setViewportSize({ width: 390, height: 844 })
      await capture(senderPage, 'home-390')

      await senderPage.getByRole('button', {
        name: '关于 P2P Transmission',
        exact: true,
      }).click()
      await expect(senderPage.getByRole('dialog', {
        name: '关于 P2P Transmission',
        exact: true,
      })).toBeVisible()
      await capture(senderPage, 'about-390')
      await senderPage.getByRole('dialog', {
        name: '关于 P2P Transmission',
        exact: true,
      }).getByRole('button', { name: '关闭', exact: true }).click()

      await senderPage.setViewportSize({ width: 1_440, height: 1_000 })
      await senderPage.getByRole('button', { name: '创建房间' }).click()
      await expect(senderPage.getByRole('button', {
        name: '复制房间码',
      })).toBeVisible()
      await capture(senderPage, 'room-owner-empty-1440')

      const roomCode = await roomCodeFromPage(senderPage)
      await receiverPage.goto('/')
      await fillRoomCode(receiverPage, roomCode)
      await receiverPage.getByRole('button', { name: '请求加入' }).click()
      await expect(receiverPage.getByRole('heading', {
        name: '等待发送者确认',
      })).toBeVisible()
      await capture(receiverPage, 'join-waiting-390')

      const joinDialog = senderPage.getByRole('dialog', { name: '加入申请' })
      await expect(joinDialog).toBeVisible()
      await capture(senderPage, 'join-request-1440')
      await joinDialog.getByRole('button', { name: '允许加入' }).click()

      await expect(senderPage.getByRole('status', {
        name: '1 位接收者已连接',
      })).toBeVisible({ timeout: 30_000 })
      await expect(receiverPage.getByRole('heading', {
        name: '等待对方发送',
      })).toBeVisible({ timeout: 30_000 })
      await capture(senderPage, 'room-owner-connected-1440')
      await capture(receiverPage, 'room-receiver-connected-390')

      await senderPage.locator('input[type="file"]').setInputFiles({
        name: 'baseline.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('P2P Transmission 1.x visual baseline'),
      })
      await capture(senderPage, 'transfer-draft-1440')
      await senderPage.getByRole('button', {
        name: '发送 1 项',
        exact: true,
      }).click()

      const incomingDialog = receiverPage.getByRole('dialog', {
        name: '收到文件',
      })
      await expect(incomingDialog.getByRole('button', {
        name: '接收全部',
      })).toBeVisible({ timeout: 30_000 })
      await capture(receiverPage, 'incoming-transfer-390')
      await incomingDialog.getByRole('button', { name: '接收全部' }).click()

      await expect(incomingDialog.getByRole('link', {
        name: '下载 baseline.txt',
      })).toBeVisible({ timeout: 30_000 })
      await expect(senderPage.getByRole('button', {
        name: '关闭结果',
      })).toBeVisible({ timeout: 30_000 })
      await capture(senderPage, 'transfer-complete-sender-1440')
      await capture(receiverPage, 'transfer-complete-receiver-390')
    } finally {
      await receiver.close()
      await sender.close()
    }
  })
})
