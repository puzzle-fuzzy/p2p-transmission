import { expect, type Page } from '@playwright/test'

export const roomCodeInputs = (page: Page) => (
  page.getByRole('group', { name: '输入 6 位房间码' }).getByRole('textbox')
)

export const enterRoomCode = async (page: Page, code: string) => {
  const inputs = roomCodeInputs(page)
  await expect(inputs).toHaveCount(6)
  await inputs.first().focus()
  await page.keyboard.type(code, { delay: 10 })
  return inputs
}
