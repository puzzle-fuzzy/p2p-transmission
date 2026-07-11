import { useEffect, useRef, useState } from 'react'
import type { PublicVisitor } from '../shared/contracts'
import Avatar from './Avatar'

type ReceiverViewContext = {
  sender?: PublicVisitor
}

export type ReceivedTextViewState = ReceiverViewContext & (
  | { status: 'waiting' }
  | { status: 'receiving' }
  | { status: 'received'; text: string }
  | { status: 'error'; message?: string }
)

export type ReceivedTextViewProps = {
  state: ReceivedTextViewState
  onCopy(text: string): void | Promise<void>
}

type CopyStatus = 'idle' | 'copying' | 'copied' | 'error'

const copyLabels: Record<CopyStatus, string> = {
  idle: '复制文本',
  copying: '正在复制…',
  copied: '已复制',
  error: '复制失败',
}

export default function ReceivedTextView({ state, onCopy }: ReceivedTextViewProps) {
  const [copyStatus, setCopyStatus] = useState<CopyStatus>('idle')
  const resetTimerRef = useRef<number | undefined>(undefined)
  const receivedText = state.status === 'received' ? state.text : ''

  useEffect(() => {
    setCopyStatus('idle')

    return () => {
      if (resetTimerRef.current !== undefined) {
        window.clearTimeout(resetTimerRef.current)
        resetTimerRef.current = undefined
      }
    }
  }, [receivedText])

  const handleCopy = async () => {
    if (state.status !== 'received' || copyStatus === 'copying') return

    setCopyStatus('copying')

    try {
      await onCopy(state.text)
      setCopyStatus('copied')
    } catch {
      setCopyStatus('error')
    }

    if (resetTimerRef.current !== undefined) {
      window.clearTimeout(resetTimerRef.current)
    }
    resetTimerRef.current = window.setTimeout(() => {
      setCopyStatus('idle')
      resetTimerRef.current = undefined
    }, 2200)
  }

  const senderSummary = state.sender ? (
    <div className="flex min-w-0 items-center gap-3">
      <Avatar
        seed={state.sender.avatarSeed}
        label={state.sender.displayName}
        className="shrink-0"
      />
      <div className="min-w-0">
        <div className="truncate text-sm text-amber-50/80">{state.sender.displayName}</div>
        <div className="text-xs text-amber-50/40">发送者</div>
      </div>
    </div>
  ) : (
    <div className="flex items-center gap-3 text-amber-50/40">
      <span
        className="material-symbols-outlined flex size-9 items-center justify-center rounded-full border border-amber-50/15"
        style={{ fontSize: '18px' }}
        aria-hidden="true"
      >
        person
      </span>
      <span className="text-xs">等待发送者</span>
    </div>
  )

  return (
    <section className="w-[calc(100vw-2rem)] max-w-xl" aria-label="文本接收状态">
      <div className="flex items-center justify-between gap-4">
        {senderSummary}
        <div className="shrink-0 text-right text-xs text-amber-50/40">
          {state.status === 'waiting' && '等待文本'}
          {state.status === 'receiving' && '接收中'}
          {state.status === 'received' && '已接收'}
          {state.status === 'error' && '接收失败'}
        </div>
      </div>

      {state.status === 'waiting' && (
        <div className="mt-6 flex min-h-56 flex-col items-center justify-center rounded-xl border border-amber-50/15 px-5 text-center">
          <span
            className="material-symbols-outlined text-amber-50/30"
            style={{ fontSize: '28px' }}
            aria-hidden="true"
          >
            sensors
          </span>
          <div className="mt-3 text-sm text-amber-50/70">等待对方发送文本</div>
          <p className="mt-2 max-w-sm text-xs leading-5 text-amber-50/50">
            收到请求时会先询问你，确认后才会接收正文。
          </p>
        </div>
      )}

      {state.status === 'receiving' && (
        <div className="mt-6 flex min-h-56 flex-col items-center justify-center rounded-xl border border-amber-50/15 px-5 text-center">
          <span
            className="material-symbols-outlined motion-safe:animate-spin text-amber-50/50"
            style={{ fontSize: '24px' }}
            aria-hidden="true"
          >
            progress_activity
          </span>
          <div className="mt-3 text-sm text-amber-50/70">正在接收文本…</div>
          <p className="mt-2 text-xs text-amber-50/50">请保持当前页面打开</p>
        </div>
      )}

      {state.status === 'received' && (
        <div className="mt-6">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-medium text-amber-50/80">收到的文本</h2>
            <span className="text-xs text-amber-50/40 tabular-nums">
              {state.text.length} 个字符
            </span>
          </div>
          <div
            className="native-scrollbar mt-3 max-h-64 min-h-40 overflow-y-auto whitespace-pre-wrap rounded-xl border border-amber-50/15 p-4 text-sm leading-6 text-amber-50/80 [overflow-wrap:anywhere]"
            tabIndex={0}
            aria-label="收到的文本内容"
          >
            {state.text}
          </div>
          <button
            type="button"
            className="mt-3 min-h-11 w-full rounded-xl bg-accent px-4 text-sm text-white/90 transition-[filter] hover:brightness-110 active:brightness-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-50/80 focus-visible:ring-offset-2 focus-visible:ring-offset-[#2d2d2d] disabled:cursor-wait disabled:brightness-75"
            disabled={copyStatus === 'copying'}
            onClick={() => { void handleCopy() }}
          >
            {copyLabels[copyStatus]}
          </button>
          <span className="sr-only" aria-live="polite" aria-atomic="true">
            {copyStatus === 'copied' && '文本已复制到剪贴板'}
            {copyStatus === 'error' && '复制失败，请重试'}
          </span>
        </div>
      )}

      {state.status === 'error' && (
        <div className="mt-6 flex min-h-56 flex-col items-center justify-center rounded-xl border border-red-300/20 bg-red-400/5 px-5 text-center">
          <span
            className="material-symbols-outlined text-red-300/70"
            style={{ fontSize: '24px' }}
            aria-hidden="true"
          >
            error
          </span>
          <div className="mt-3 text-sm text-red-200/80">文本接收未完成</div>
          <p className="mt-2 max-w-sm text-xs leading-5 text-red-100/60">
            {state.message ?? '连接已中断，请让发送者重新发送。'}
          </p>
        </div>
      )}
    </section>
  )
}
