import { expect, type Page } from '@playwright/test'

export const roomCodeFromPage = async (page: Page) => {
  const code = await page
    .getByRole('button', { name: '复制房间码' })
    .textContent()
  const normalized = code?.replace(/\D/g, '')
  expect(normalized).toMatch(/^\d{6}$/u)
  return normalized as string
}

export const fillRoomCode = async (page: Page, code: string) => {
  for (const [index, digit] of Array.from(code).entries()) {
    await page
      .getByRole('textbox', { name: `房间码第 ${String(index + 1)} 位` })
      .fill(digit)
  }
}
