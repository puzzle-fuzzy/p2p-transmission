import { expect, type Page } from '@playwright/test'

export const roomCodeInput = (page: Page) => (
  page.getByRole('textbox', { name: '输入 6 位房间码' })
)

export const enterRoomCode = async (page: Page, code: string) => {
  const input = roomCodeInput(page)
  await expect(input).toHaveCount(1)
  await input.focus()
  await page.keyboard.type(code, { delay: 10 })
  return input
}
