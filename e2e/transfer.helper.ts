import type { Page } from '@playwright/test'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { connectSingleReceiverRoom as connectRoom } from './room.helper'

export const currentDirectory = dirname(fileURLToPath(import.meta.url))

export const sha256File = async (path: string) => {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk)
  }
  return hash.digest('hex')
}

export const useFileInputFallback = async (page: Page) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'showOpenFilePicker', {
      configurable: true,
      value: undefined,
    })
  })
}

export const connectSingleReceiverRoom = async (
  owner: Page,
  receiver: Page,
  options: { persistentSource?: boolean } = {},
) => {
  await connectRoom(owner, receiver, {
    beforeOwnerNavigation: options.persistentSource ? undefined : useFileInputFallback,
  })
}
