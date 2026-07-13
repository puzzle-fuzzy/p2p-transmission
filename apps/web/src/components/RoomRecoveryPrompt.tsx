import { useId } from 'react'

export type RoomRecoveryPromptProps = {
  roomCode: string
  busy?: boolean
  onRetry(): void
}

export default function RoomRecoveryPrompt({
  roomCode,
  busy = false,
  onRetry,
}: RoomRecoveryPromptProps) {
  const titleId = useId()

  return (
    <section
      className="mb-4 flex w-full items-center gap-3 rounded-xl border border-amber-50/15 bg-white/5 p-3"
      aria-labelledby={titleId}
    >
      <span
        className="material-symbols-outlined shrink-0 text-accent"
        style={{ fontSize: '19px' }}
        aria-hidden="true"
      >
        sync_problem
      </span>
      <div className="min-w-0 flex-1">
        <h2 id={titleId} className="text-sm font-normal text-amber-50/80">
          上次房间暂时未连接
        </h2>
        <p className="mt-1 truncate text-xs text-amber-50/50">
          房间 <span className="font-mono tracking-wider">{roomCode}</span> 的接收身份仍保留
        </p>
      </div>
      <button
        type="button"
        className="min-h-11 shrink-0 rounded-xl border border-amber-50/15 px-3 text-sm text-amber-50/70 transition-colors hover:bg-white/5 hover:text-amber-50/90 focus-visible:border-accent focus-visible:outline-none disabled:cursor-wait disabled:text-amber-50/25"
        disabled={busy}
        onClick={onRetry}
      >
        {busy ? '重新连接中…' : '重新连接'}
      </button>
    </section>
  )
}
