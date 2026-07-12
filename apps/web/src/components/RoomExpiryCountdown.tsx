import { useEffect, useState } from 'react'

export type RoomExpiryCountdownProps = {
  expiresAt: number
  onExpire?: () => void
}

const formatRemaining = (ms: number): { text: string; urgent: boolean } => {
  if (ms <= 0) return { text: '已到期', urgent: true }
  if (ms < 60_000) {
    const s = Math.ceil(ms / 1000)
    return { text: `${s}秒`, urgent: true }
  }
  if (ms < 3_600_000) {
    const m = Math.floor(ms / 60_000)
    const s = Math.ceil((ms % 60_000) / 1000)
    return { text: `${m}分${s}秒`, urgent: false }
  }
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  return { text: `${h}时${m}分`, urgent: false }
}

export default function RoomExpiryCountdown({
  expiresAt,
  onExpire,
}: RoomExpiryCountdownProps) {
  const [remaining, setRemaining] = useState(() => Math.max(0, expiresAt - Date.now()))
  const [expired, setExpired] = useState(false)

  useEffect(() => {
    if (expired) return

    const tick = () => {
      const ms = Math.max(0, expiresAt - Date.now())
      setRemaining(ms)
      if (ms <= 0) {
        setExpired(true)
        onExpire?.()
        return
      }
    }

    tick()
    const interval = setInterval(tick, 1000)
    return () => clearInterval(interval)
  }, [expiresAt, expired, onExpire])

  if (expired) return null

  const { text, urgent } = formatRemaining(remaining)

  return (
    <span
      className={`text-xs tabular-nums transition-colors ${
        urgent ? 'text-amber-50/70' : 'text-amber-50/40'
      }`}
      aria-label={`房间剩余 ${text}`}
      title={`房间剩余时间：${text}`}
    >
      {urgent && (
        <span className="mr-1 inline-block size-1.5 rounded-full bg-amber-50/50" aria-hidden="true" />
      )}
      {text}
    </span>
  )
}
