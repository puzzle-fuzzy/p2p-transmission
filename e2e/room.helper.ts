import { expect, type Page } from '@playwright/test'

import { enterRoomCode } from './room-code.helper'

export interface ConnectSingleReceiverRoomOptions {
  beforeOwnerNavigation?: (owner: Page) => Promise<void>
  readiness?: 'both' | 'owner'
  readyTimeout?: number
}

export const createRoom = async (owner: Page) => {
  await owner.goto('/')
  await owner.getByRole('button', { name: '创建房间' }).click()

  const roomCode = (
    await owner.getByRole('button', { name: /复制房间码/ }).textContent()
  )?.trim() ?? ''
  expect(roomCode).toMatch(/^[A-Z2-9]{6}$/)
  return roomCode
}

export const requestRoomJoin = async (receiver: Page, roomCode: string) => {
  await receiver.goto('/')
  await enterRoomCode(receiver, roomCode)
  await receiver.getByRole('button', { name: '请求加入' }).click()
}

export const approveRoomJoin = async (owner: Page) => {
  const requestDialog = owner.getByRole('dialog', { name: '加入申请' })
  await expect(requestDialog).toBeVisible()
  await requestDialog.getByRole('button', { name: '允许加入' }).click()
  return requestDialog
}

export const connectReceiver = async (
  owner: Page,
  receiver: Page,
  roomCode: string,
) => {
  await requestRoomJoin(receiver, roomCode)
  await approveRoomJoin(owner)
}

export const connectSingleReceiverRoom = async (
  owner: Page,
  receiver: Page,
  options: ConnectSingleReceiverRoomOptions = {},
) => {
  await options.beforeOwnerNavigation?.(owner)
  const roomCode = await createRoom(owner)
  await connectReceiver(owner, receiver, roomCode)

  const readyOptions = options.readyTimeout === undefined
    ? {}
    : { timeout: options.readyTimeout }
  await expect(owner.getByRole('heading', { name: '选择要发送的文件' })).toBeVisible(
    readyOptions,
  )
  if (options.readiness !== 'owner') {
    await expect(receiver.getByRole('heading', { name: '等待对方发送' })).toBeVisible(
      readyOptions,
    )
  }

  return roomCode
}
