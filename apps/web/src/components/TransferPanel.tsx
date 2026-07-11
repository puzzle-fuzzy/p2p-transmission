import { useId, useRef, useState } from 'react'
import Avatar from './Avatar'
import type { PublicRoom, PublicVisitor } from '../shared/contracts'

type Tab = 'text' | 'file'

const MAX_CHARS = 500

export type TransferPanelProps = {
  visitor: PublicVisitor
  room: PublicRoom
  readyPeerCount: number
  onSendText(text: string): void | Promise<void>
}

export default function TransferPanel({
  visitor,
  room,
  readyPeerCount,
  onSendText,
}: TransferPanelProps) {
  const [tab, setTab] = useState<Tab>('text')
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState('')
  const textTabRef = useRef<HTMLButtonElement>(null)
  const fileTabRef = useRef<HTMLButtonElement>(null)
  const tabId = useId()
  const connectedCount = Math.max(0, Math.trunc(readyPeerCount))
  const hasText = Boolean(text.trim())
  const canSendText = connectedCount > 0 && hasText && !sending

  const handleSendText = async () => {
    if (!canSendText) return

    const textSnapshot = text
    setSending(true)
    setSendError('')

    try {
      await onSendText(textSnapshot)
      setText(current => current === textSnapshot ? '' : current)
    } catch {
      setSendError('无法发起文本传输，请稍后重试。')
    } finally {
      setSending(false)
    }
  }

  const sendButtonLabel = sending
    ? '正在发出请求…'
    : connectedCount === 0
      ? '等待接收者连接'
      : connectedCount === 1
        ? '发送给 1 位接收者'
        : `发送给 ${connectedCount} 位接收者`

  const selectTab = (nextTab: Tab, focus = false) => {
    setTab(nextTab)
    setSendError('')
    if (focus) {
      const target = nextTab === 'text' ? textTabRef.current : fileTabRef.current
      target?.focus()
    }
  }

  const handleTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return

    event.preventDefault()
    selectTab(event.key === 'ArrowLeft' || event.key === 'Home' ? 'text' : 'file', true)
  }

  return (
    <section className="native-scrollbar flex max-h-[calc(100svh-2rem)] w-[calc(100vw-2rem)] max-w-xl flex-col gap-5 overflow-y-auto py-0.5 sm:gap-6" aria-label="发送内容">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div
          className="flex w-full rounded-xl bg-white/5 p-1 sm:w-auto"
          role="tablist"
          aria-label="传输类型"
        >
          <button
            ref={textTabRef}
            id={`${tabId}-text-tab`}
            type="button"
            role="tab"
            aria-selected={tab === 'text'}
            aria-controls={`${tabId}-text-panel`}
            tabIndex={tab === 'text' ? 0 : -1}
            className={`min-h-11 flex-1 rounded-lg px-4 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-[#2d2d2d] sm:flex-none ${
              tab === 'text'
                ? 'bg-white/10 text-amber-50/80'
                : 'text-amber-50/60 hover:text-amber-50/80'
            }`}
            onClick={() => selectTab('text')}
            onKeyDown={handleTabKeyDown}
          >
            传输文本
          </button>
          <button
            ref={fileTabRef}
            id={`${tabId}-file-tab`}
            type="button"
            role="tab"
            aria-selected={tab === 'file'}
            aria-controls={`${tabId}-file-panel`}
            tabIndex={tab === 'file' ? 0 : -1}
            className={`min-h-11 flex-1 rounded-lg px-4 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-[#2d2d2d] sm:flex-none ${
              tab === 'file'
                ? 'bg-white/10 text-amber-50/80'
                : 'text-amber-50/60 hover:text-amber-50/80'
            }`}
            onClick={() => selectTab('file')}
            onKeyDown={handleTabKeyDown}
          >
            传输文件
          </button>
        </div>

        <div className="flex items-center justify-between gap-3 sm:justify-end">
          <div className="min-w-0 text-left sm:text-right">
            <div className="text-xs text-amber-50/50 tabular-nums">房间 {room.code}</div>
            <div className="mt-0.5 text-xs text-amber-50/60">
              {connectedCount > 0
                ? `${connectedCount} 位接收者已连接`
                : '等待接收者连接'}
            </div>
          </div>
          <Avatar seed={visitor.avatarSeed} label={visitor.displayName} className="shrink-0" />
        </div>
      </div>

      {sendError && (
        <div className="flex items-center gap-2 rounded-xl border border-red-300/20 bg-red-400/5 px-4 py-2.5 text-xs text-red-200/80" role="alert">
          <span className="material-symbols-outlined shrink-0" style={{ fontSize: '16px' }} aria-hidden="true">warning</span>
          <span className="min-w-0 flex-1">{sendError}</span>
          <button
            type="button"
            className="flex size-11 shrink-0 items-center justify-center rounded-lg text-red-200/50 transition-colors hover:text-red-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-200/70"
            onClick={() => setSendError('')}
            aria-label="关闭错误提示"
          >
            <span className="material-symbols-outlined" style={{ fontSize: '16px' }} aria-hidden="true">close</span>
          </button>
        </div>
      )}

      {tab === 'text' && (
        <div
          id={`${tabId}-text-panel`}
          role="tabpanel"
          aria-labelledby={`${tabId}-text-tab`}
        >
          <div className="relative h-52 sm:h-56" style={{ fontSize: 0 }}>
            <textarea
              placeholder="输入要传输的文本…"
              maxLength={MAX_CHARS}
              value={text}
              onChange={event => {
                setText(event.target.value)
                if (sendError) setSendError('')
              }}
              className="native-scrollbar h-full w-full resize-none rounded-xl border border-amber-50/15 bg-transparent p-4 pb-9 text-sm text-amber-50/80 outline-none transition-colors placeholder:text-amber-50/50 focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-[#2d2d2d]"
              aria-label="要传输的文本"
            />
            <span className="pointer-events-none absolute bottom-4 right-4 text-xs text-amber-50/60 tabular-nums">
              {text.length}/{MAX_CHARS}
            </span>
          </div>
        </div>
      )}

      {tab === 'file' && (
        <div
          id={`${tabId}-file-panel`}
          role="tabpanel"
          aria-labelledby={`${tabId}-file-tab`}
          className="flex h-52 flex-col items-center justify-center rounded-xl border-2 border-dashed border-amber-50/15 px-5 text-center sm:h-56"
        >
          <span
            className="material-symbols-outlined text-amber-50/30"
            style={{ fontSize: '28px' }}
            aria-hidden="true"
          >
            upload_file
          </span>
          <div className="mt-3 text-sm text-amber-50/60">文件传输将在下一阶段开放</div>
          <p className="mt-2 max-w-sm text-xs leading-5 text-amber-50/60">
            当前里程碑先完成真实文本传输，文件分片与进度将在后续接入。
          </p>
        </div>
      )}

      <button
        type="button"
        className={`flex min-h-11 w-full items-center justify-center gap-2 rounded-xl px-4 text-sm transition-[filter,color,background-color] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-50/80 focus-visible:ring-offset-2 focus-visible:ring-offset-[#2d2d2d] ${
          tab === 'file' || !canSendText
            ? 'cursor-not-allowed bg-white/5 text-amber-50/30'
            : 'cursor-pointer bg-accent text-white/90 hover:brightness-110 active:brightness-90'
        }`}
        disabled={tab === 'file' || !canSendText}
        onClick={() => { void handleSendText() }}
      >
        {tab === 'file' ? (
          '文件传输暂未开放'
        ) : (
          <>
            {sending && (
              <span
                className="material-symbols-outlined motion-safe:animate-spin"
                style={{ fontSize: '16px' }}
                aria-hidden="true"
              >
                progress_activity
              </span>
            )}
            {sendButtonLabel}
          </>
        )}
      </button>
    </section>
  )
}
