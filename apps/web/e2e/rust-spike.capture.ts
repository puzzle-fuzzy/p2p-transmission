import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'

const fileMiB = Number(process.env.SPIKE_FILE_MIB ?? '8')
const fileBytes = fileMiB * 1024 * 1024

test('two Dioxus peers exchange text and a verified file', async ({
  browser,
  browserName,
  baseURL,
}) => {
  const first = await browser.newContext({ baseURL })
  const second = await browser.newContext({ baseURL })
  let temporaryDirectory: string | undefined

  try {
    const firstPage = await first.newPage()
    const secondPage = await second.newPage()
    const room = `e2e-${Date.now().toString(36)}`

    for (const page of [firstPage, secondPage]) {
      await page.goto('/')
    }
    const supportsPeerConnection = await firstPage.evaluate(
      () => typeof globalThis.RTCPeerConnection === 'function',
    )
    test.skip(
      !supportsPeerConnection,
      `${browserName} runtime does not expose RTCPeerConnection; verify real Safari on macOS/iOS.`,
    )

    for (const page of [firstPage, secondPage]) {
      await page.getByRole('textbox', { name: 'Spike room' }).fill(room)
    }

    await firstPage.getByRole('button', {
      name: '连接 signaling',
    }).click()
    await secondPage.getByRole('button', {
      name: '连接 signaling',
    }).click()

    try {
      for (const page of [firstPage, secondPage]) {
        await expect(page.getByRole('button', {
          name: '发送文本',
        })).toBeEnabled({ timeout: 30_000 })
      }
    } catch (error) {
      for (const [label, page] of [
        ['first', firstPage],
        ['second', secondPage],
      ] as const) {
        const connection = page.getByRole('region', { name: '连接设置' })
        const diagnostic = page.getByRole('region', { name: '诊断日志' })
        console.log(`${label} connection:\n${await connection.innerText()}`)
        console.log(`${label} diagnostic:\n${await diagnostic.innerText()}`)
      }
      throw error
    }

    const text = `Rust DataChannel ${Date.now().toString(36)}`
    await firstPage.getByRole('textbox', {
      name: '要通过 DataChannel 发送的文本',
    }).fill(text)
    await firstPage.getByRole('button', { name: '发送文本' }).click()
    await expect(secondPage.getByText(`收到：${text}`, {
      exact: true,
    })).toBeVisible()

    const fileName = `rust-spike-${String(fileMiB)}mib.bin`
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'p2p-rust-spike-'))
    const filePath = join(temporaryDirectory, fileName)
    await writeFile(filePath, Buffer.alloc(fileBytes, 0x5a))
    await firstPage.locator('input[type="file"]').setInputFiles(filePath)
    await firstPage.getByRole('button', { name: '发送文件' }).click()

    await expect(secondPage.getByRole('link', {
      name: `下载 ${fileName}`,
    })).toBeVisible({ timeout: 150_000 })
    await expect(secondPage.getByText(`${fileName} 完整性校验通过`, {
      exact: true,
    })).toBeVisible()
    await expect(firstPage.getByText(new RegExp(
      `发送 ${fileName}：${String(fileBytes)} / ${String(fileBytes)} bytes`,
    ))).toBeVisible()

    const diagnostic = firstPage.getByRole('region', { name: '诊断日志' })
    await expect(diagnostic).toContainText('max buffered_amount=')
    const diagnosticText = await diagnostic.innerText()
    const bufferedMatch = /max buffered_amount=(\d+) bytes/u.exec(diagnosticText)
    expect(bufferedMatch).not.toBeNull()
    const maxBufferedAmount = Number(bufferedMatch?.[1])
    expect(maxBufferedAmount).toBeLessThanOrEqual(5 * 1024 * 1024)
    console.log(`max buffered_amount=${String(maxBufferedAmount)} bytes`)
  } finally {
    await second.close()
    await first.close()
    if (temporaryDirectory) {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  }
})
