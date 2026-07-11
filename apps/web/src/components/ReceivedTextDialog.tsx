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
      className="incoming-transfer-dialog m-auto max-h-[calc(100svh-2rem)] w-[calc(100%-2rem)] max-w-lg overflow-y-auto rounded-xl border border-amber-50/15 bg-[#373737] p-0 text-amber-50/80 backdrop:bg-black/60"
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
          className="native-scrollbar mt-5 max-h-[min(45svh,20rem)] min-h-32 overflow-y-auto whitespace-pre-wrap rounded-lg border border-amber-50/15 bg-white/5 p-4 text-sm leading-6 text-amber-50/80 [overflow-wrap:anywhere]"
          tabIndex={0}
        >
          {text}
        </div>

        <div className="mt-5 grid grid-cols-2 gap-2">
          <button
            type="button"
            className="min-h-11 rounded-xl border border-amber-50/15 px-4 text-sm tracking-[0.05em] text-amber-50/60 transition-colors hover:bg-white/5 hover:text-amber-50/80 focus-visible:border-accent focus-visible:outline-none disabled:cursor-wait disabled:text-amber-50/20"
            disabled={copyStatus === 'copying'}
            onClick={onCopy}
          >
            {copyLabels[copyStatus]}
          </button>
          <button
            ref={closeButtonRef}
            type="button"
            className="min-h-11 rounded-xl border border-accent bg-accent px-4 text-sm tracking-[0.05em] text-white/90 transition-[filter,border-color] hover:brightness-110 active:brightness-90 focus-visible:border-amber-50/80 focus-visible:outline-none"
            onClick={closeOnce}
          >
            关闭
          </button>
        </div>

        <span className="sr-only" aria-live="polite" aria-atomic="true">
          {copyStatus === 'copied' && '文本已复制'}
          {copyStatus === 'error' && '复制失败'}
        </span>
      </div>
    </dialog>
  )
}
