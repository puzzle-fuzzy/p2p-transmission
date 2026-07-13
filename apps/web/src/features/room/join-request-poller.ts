import type { RoomJoinRequestReceipt } from '../../shared/contracts'

export type JoinRequestPoller = {
  start(): void
  stop(): void
}

export type JoinRequestSchedule = (
  handler: () => void,
  delay: number,
) => ReturnType<typeof setTimeout>

export type JoinRequestCancelSchedule = (
  timer: ReturnType<typeof setTimeout>,
) => void

export type JoinRequestPollerOptions = {
  read(): Promise<RoomJoinRequestReceipt>
  onReceipt(receipt: RoomJoinRequestReceipt): void
  onError(error: unknown): void
  intervalMs?: number
  schedule?: JoinRequestSchedule
  cancelSchedule?: JoinRequestCancelSchedule
}

export const createJoinRequestPoller = ({
  read,
  onReceipt,
  onError,
  intervalMs = 2_000,
  schedule = setTimeout,
  cancelSchedule = clearTimeout,
}: JoinRequestPollerOptions): JoinRequestPoller => {
  if (!Number.isFinite(intervalMs) || intervalMs < 0) {
    throw new RangeError('Join request polling interval must be non-negative')
  }

  let active = false
  let generation = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  const clearScheduledRead = () => {
    if (timer === undefined) return
    cancelSchedule(timer)
    timer = undefined
  }

  const readOnce = async (currentGeneration: number): Promise<void> => {
    if (!active || generation !== currentGeneration) return

    let receipt: RoomJoinRequestReceipt
    try {
      receipt = await read()
    } catch (error) {
      if (!active || generation !== currentGeneration) return
      active = false
      onError(error)
      return
    }

    if (!active || generation !== currentGeneration) return

    if (receipt.state !== 'pending') {
      active = false
      onReceipt(receipt)
      return
    }

    onReceipt(receipt)
    if (!active || generation !== currentGeneration) return

    timer = schedule(() => {
      timer = undefined
      void readOnce(currentGeneration)
    }, intervalMs)
  }

  return {
    start() {
      if (active) return
      active = true
      const currentGeneration = ++generation
      void readOnce(currentGeneration)
    },
    stop() {
      if (!active && timer === undefined) return
      active = false
      generation += 1
      clearScheduledRead()
    },
  }
}
