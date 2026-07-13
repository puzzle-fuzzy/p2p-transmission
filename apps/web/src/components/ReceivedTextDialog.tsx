import { useEffect, useId, useRef } from 'react'
import type { PublicVisitor } from '../shared/contracts'
import Avatar from './Avatar'

export type ReceivedTextCopyStatus = 'idle' | 'copying' | 'copied' | 'error'

export type ReceivedTextDialogProps = {
  sender: PublicVisitor
  text: string
  copyStatus: ReceivedTextCopyStatus
  onCopy(): void
  onClose(): void
}

const copyLabels: Record<ReceivedTextCopyStatus, string> = {
  idle: '复制',
  copying: '复制中…',
  copied: '已复制',
  error: '复制失败',
}

const copyIcons: Record<ReceivedTextCopyStatus, string> = {
  idle: 'content_copy',
  copying: 'progress_activity',
  copied: 'check_circle',
  error: 'error',
}

const copyStatusMessages: Record<ReceivedTextCopyStatus, string> = {
  idle: '',
  copying: '正在复制到剪贴板…',
  copied: '文本已复制到剪贴板',
  error: '复制失败，请重试',
}

export default function ReceivedTextDialog({
  sender,
  text,
  copyStatus,
  onCopy,
  onClose,
}: ReceivedTextDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const closingRef = useRef(false)
  const titleId = useId()
  const senderId = useId()
  const bodyId = useId()

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return undefined

    closingRef.current = false
    if (!dialog.open) dialog.showModal()
    closeButtonRef.current?.focus()

    return () => {
      if (dialog.open) dialog.close()
    }
  }, [sender.id, text])

  const closeOnce = () => {
    if (closingRef.current) return

    closingRef.current = true
    dialogRef.current?.close()
    onClose()
  }

  return (
    <dialog
      ref={dialogRef}
      className="incoming-transfer-dialog m-auto max-h-[calc(100svh-2rem)] w-[calc(100%-2rem)] max-w-lg overflow-y-auto rounded-xl border border-amber-50/15 bg-surface-elevated p-0 text-amber-50/80 backdrop:bg-black/60"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={`${senderId} ${bodyId}`}
      onCancel={event => {
        event.preventDefault()
        closeOnce()
      }}
    >
      <div className="p-5 sm:p-6">
        <div className="flex min-w-0 items-center gap-3">
          <Avatar
            seed={sender.avatarSeed}
            label={sender.displayName}
            className="shrink-0"
          />
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-sm font-normal text-amber-50/80">
              收到文本
            </h2>
            <p id={senderId} className="mt-1 truncate text-xs text-amber-50/50">
              来自 {sender.displayName}
            </p>
          </div>
        </div>

        <div
          id={bodyId}
          className="native-scrollbar mt-5 max-h-[min(45svh,20rem)] min-h-32 overflow-y-auto whitespace-pre-wrap rounded-lg border border-amber-50/15 bg-white/5 p-4 text-sm leading-6 text-amber-50/80 wrap-anywhere"
          tabIndex={0}
        >
          {text}
        </div>

        <div className="mt-5 grid grid-cols-2 gap-2">
          <button
            type="button"
            data-copy-status={copyStatus}
            className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border px-4 text-sm tracking-wider transition-[background-color,border-color,color] focus-visible:border-accent focus-visible:outline-none disabled:cursor-wait disabled:text-amber-50/20 ${
              copyStatus === 'copied'
                ? 'border-accent bg-accent/10 text-accent hover:bg-accent/20'
                : copyStatus === 'error'
                  ? 'border-amber-50/30 bg-white/5 text-amber-50/80 hover:bg-white/10'
                  : 'border-amber-50/15 text-amber-50/60 hover:bg-white/5 hover:text-amber-50/80'
            }`}
            disabled={copyStatus === 'copying'}
            onClick={onCopy}
          >
            <span
              data-testid="copy-status-icon"
              className="material-symbols-outlined text-[18px] leading-none"
              aria-hidden="true"
            >
              {copyIcons[copyStatus]}
            </span>
            <span>{copyLabels[copyStatus]}</span>
          </button>
          <button
            ref={closeButtonRef}
            type="button"
            className="min-h-11 rounded-xl border border-accent bg-accent px-4 text-sm tracking-wider text-white/90 transition-[filter,border-color] hover:brightness-110 active:brightness-90 focus-visible:border-amber-50/80 focus-visible:outline-none"
            onClick={closeOnce}
          >
            关闭
          </button>
        </div>

        <p
          data-testid="copy-status-message"
          className="mt-2 min-h-5 text-center text-xs text-amber-50/60"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {copyStatusMessages[copyStatus]}
        </p>
      </div>
    </dialog>
  )
}
