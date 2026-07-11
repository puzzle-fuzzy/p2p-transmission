export type RoomSessionLifecycleOptions = {
  expiresAt: number
  now?: () => number
  setTimer?: (handler: () => void, delay: number) => ReturnType<typeof setTimeout>
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void
  isCurrent?: () => boolean
  onExpire(): void
}

export type RoomSessionLifecycle = {
  start(): void
  check(): boolean
  onVisibilityChange(): boolean
  onReconnect(): boolean
  beforePeerRetry(): boolean
  isActive(): boolean
  stop(): void
}

export const createRoomSessionLifecycle = ({
  expiresAt,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  isCurrent = () => true,
  onExpire,
}: RoomSessionLifecycleOptions): RoomSessionLifecycle => {
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0) {
    throw new RangeError('Room expiry must use epoch milliseconds')
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  let active = false
  let expired = false

  const clear = () => {
    if (timer === undefined) return
    clearTimer(timer)
    timer = undefined
  }

  const expire = () => {
    if (!active || expired || !isCurrent()) return false
    expired = true
    active = false
    clear()
    onExpire()
    return true
  }

  const check = () => {
    if (!active || expired || !isCurrent()) return false
    if (now() < expiresAt) return true
    expire()
    return false
  }

  return {
    start() {
      if (active || expired) return
      active = true
      if (!check()) return
      timer = setTimer(() => {
        timer = undefined
        expire()
      }, Math.max(0, expiresAt - now()))
    },
    check,
    onVisibilityChange: check,
    onReconnect: check,
    beforePeerRetry: check,
    isActive() {
      return active && !expired && isCurrent()
    },
    stop() {
      active = false
      clear()
    },
  }
}
