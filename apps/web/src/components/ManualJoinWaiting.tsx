import { useEffect, useId, useState } from 'react'
import type { PublicVisitor } from '../shared/contracts'
import Avatar from './Avatar'

export type ManualJoinWaitingProps = {
  visitor: PublicVisitor
  roomCode: string
  expiresAt: number
  busy?: boolean
  error?: string
  onCancel(): void
  onChangeRoom(): void
  onRetry?(): void
}

const formatRemaining = (remainingSeconds: number) => {
  const minutes = Math.floor(remainingSeconds / 60)
  const seconds = remainingSeconds % 60

  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

export default function ManualJoinWaiting({
  visitor,
  roomCode,
  expiresAt,
  busy = false,
  error,
  onCancel,
  onChangeRoom,
  onRetry,
}: ManualJoinWaitingProps) {
  const [now, setNow] = useState(() => Date.now())
  const titleId = useId()
  const remainingSeconds = Math.max(0, Math.ceil((expiresAt - now) / 1000))

  useEffect(() => {
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)

    return () => window.clearInterval(timer)
  }, [expiresAt])

  return (
    <section
      className="flex w-[calc(100vw-2rem)] max-w-sm flex-col items-center text-center"
      aria-labelledby={titleId}
    >
      <Avatar
        seed={visitor.avatarSeed}
        label={visitor.displayName}
        className="size-11 shrink-0"
      />
      <p className="mt-3 max-w-full truncate text-sm text-amber-50/80">
        {visitor.displayName}
      </p>
      <p className="mt-1 text-xs text-amber-50/50">正在申请加入房间</p>

      <div className="mt-6 w-full rounded-xl bg-white/5 px-5 py-6">
        <h2 id={titleId} className="text-sm font-normal text-amber-50/80">
          等待发送者确认
        </h2>
        <p className="mt-3 font-mono text-xl tracking-[0.15em] text-amber-50/80">
          {roomCode}
        </p>
        <p
          className="mt-3 text-xs text-amber-50/50"
          role={remainingSeconds === 0 ? 'status' : undefined}
        >
          {remainingSeconds > 0
            ? `申请将在 ${formatRemaining(remainingSeconds)} 后失效`
            : '申请已过期'}
        </p>
      </div>

      {error && (
        <div className="mt-4 w-full rounded-lg border border-amber-50/15 px-4 py-3 text-left">
          <p role="alert" className="text-xs leading-5 text-amber-50/70">
            {error}
          </p>
          {onRetry && (
            <button
              type="button"
              className="mt-2 min-h-11 rounded-xl px-3 text-sm text-amber-50/70 transition-colors hover:bg-white/5 hover:text-amber-50/80 focus-visible:bg-white/5 focus-visible:outline-none disabled:cursor-not-allowed disabled:text-amber-50/20"
              disabled={busy}
              onClick={onRetry}
            >
              重试
            </button>
          )}
        </div>
      )}

      <div className="mt-5 grid w-full grid-cols-2 gap-2">
        <button
          type="button"
          className="min-h-11 rounded-xl border border-amber-50/15 px-3 text-sm text-amber-50/60 transition-colors hover:bg-white/5 hover:text-amber-50/80 focus-visible:border-accent focus-visible:outline-none disabled:cursor-not-allowed disabled:text-amber-50/20"
          disabled={busy}
          onClick={onCancel}
        >
          取消申请
        </button>
        <button
          type="button"
          className="min-h-11 rounded-xl border border-amber-50/15 px-3 text-sm text-amber-50/70 transition-colors hover:bg-white/5 hover:text-amber-50/80 focus-visible:border-accent focus-visible:outline-none disabled:cursor-not-allowed disabled:text-amber-50/20"
          disabled={busy}
          onClick={onChangeRoom}
        >
          更换房间
        </button>
      </div>
    </section>
  )
}
