import { useEffect, useId, useRef, useState } from 'react'
import type { PublicVisitor } from '../shared/contracts'
import Avatar from './Avatar'

export type RecipientPickerDialogProps = {
  receivers: readonly PublicVisitor[]
  selectedIds: readonly string[]
  onConfirm(ids: string[]): void
  onClose(): void
}

export default function RecipientPickerDialog({
  receivers,
  selectedIds,
  onConfirm,
  onClose,
}: RecipientPickerDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const cancelButtonRef = useRef<HTMLButtonElement>(null)
  const closingRef = useRef(false)
  const titleId = useId()
  const descriptionId = useId()
  const [draftIds, setDraftIds] = useState<string[]>(() => (
    receivers.filter(receiver => selectedIds.includes(receiver.id)).map(receiver => receiver.id)
  ))
  const [error, setError] = useState('')
  const requestKey = receivers.map(receiver => receiver.id).join('\u0000')

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return undefined
    closingRef.current = false
    if (!dialog.open) dialog.showModal()
    cancelButtonRef.current?.focus()

    return () => {
      if (dialog.open) dialog.close()
    }
  }, [requestKey])

  const toggle = (receiverId: string) => {
    setError('')
    setDraftIds(current => current.includes(receiverId)
      ? current.filter(id => id !== receiverId)
      : [...current, receiverId])
  }

  const selectAll = () => {
    setError('')
    setDraftIds(receivers.map(receiver => receiver.id))
  }

  const clearAll = () => {
    setError('')
    setDraftIds([])
  }

  const confirm = () => {
    if (draftIds.length === 0) {
      setError('至少选择一位接收者')
      return
    }

    const orderedIds = receivers
      .filter(receiver => draftIds.includes(receiver.id))
      .map(receiver => receiver.id)
    closingRef.current = true
    dialogRef.current?.close()
    onConfirm(orderedIds)
  }

  const close = () => {
    if (closingRef.current) return
    closingRef.current = true
    dialogRef.current?.close()
    onClose()
  }

  return (
    <dialog
      ref={dialogRef}
      className="m-auto max-h-[calc(100svh-2rem)] w-[calc(100%-2rem)] max-w-sm overflow-y-auto rounded-xl border border-amber-50/15 bg-surface-elevated p-0 text-amber-50/80 backdrop:bg-black/60"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onKeyDown={event => {
        if (event.key !== 'Escape') return
        event.preventDefault()
        close()
      }}
      onCancel={event => {
        event.preventDefault()
        close()
      }}
    >
      <div className="p-5 sm:p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id={titleId} className="text-sm font-normal text-amber-50/80">选择接收者</h2>
            <p id={descriptionId} className="mt-1 text-xs leading-5 text-amber-50/50">
              选择本次发送要通知的接收者
            </p>
          </div>
          <span className="shrink-0 text-xs tabular-nums text-amber-50/50">
            已选 {String(draftIds.length)} 人
          </span>
        </div>

        <div className="mt-4 flex items-center gap-2">
          <button
            type="button"
            className="min-h-10 rounded-lg border border-amber-50/15 px-3 text-xs text-amber-50/60 transition-colors hover:bg-white/5 hover:text-amber-50/80 focus-visible:border-accent focus-visible:outline-none"
            onClick={selectAll}
          >
            全选
          </button>
          <button
            type="button"
            className="min-h-10 rounded-lg border border-amber-50/15 px-3 text-xs text-amber-50/60 transition-colors hover:bg-white/5 hover:text-amber-50/80 focus-visible:border-accent focus-visible:outline-none"
            onClick={clearAll}
          >
            清空选择
          </button>
        </div>

        <div className="mt-4 space-y-2" role="group" aria-label="可选接收者">
          {receivers.map(receiver => {
            const checked = draftIds.includes(receiver.id)
            return (
              <label
                key={receiver.id}
                data-selected={checked ? 'true' : 'false'}
                className={`flex min-h-14 cursor-pointer items-center gap-3 rounded-xl border px-3 transition-[background-color,border-color] focus-within:border-accent focus-within:outline-none ${checked ? 'border-accent/60 bg-accent/15' : 'border-amber-50/10 hover:bg-white/5'}`}
              >
                <input
                  type="checkbox"
                  className="peer sr-only"
                  checked={checked}
                  onChange={() => toggle(receiver.id)}
                  aria-label={receiver.displayName}
                />
                <span
                  data-testid="recipient-check-indicator"
                  aria-hidden="true"
                  className={`flex size-5 shrink-0 items-center justify-center rounded-md border transition-[background-color,border-color,color] motion-reduce:transition-none ${checked ? 'border-accent bg-accent text-white' : 'border-amber-50/30 bg-transparent text-transparent'}`}
                >
                  <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>check</span>
                </span>
                <Avatar seed={receiver.avatarSeed} label={receiver.displayName} className="shrink-0" />
                <span className="min-w-0 flex-1 truncate text-sm text-amber-50/80">
                  {receiver.displayName}
                </span>
              </label>
            )
          })}
        </div>

        {error && (
          <p className="mt-4 text-xs leading-5 text-amber-50/70" role="alert">{error}</p>
        )}

        <div className="mt-5 grid grid-cols-2 gap-2">
          <button
            ref={cancelButtonRef}
            type="button"
            className="min-h-11 rounded-xl border border-amber-50/15 px-4 text-sm text-amber-50/60 transition-colors hover:bg-white/5 hover:text-amber-50/80 focus-visible:border-accent focus-visible:outline-none"
            onClick={close}
          >
            取消
          </button>
          <button
            type="button"
            className="min-h-11 rounded-xl border border-accent bg-accent px-4 text-sm text-white/90 transition-[filter,border-color] hover:brightness-110 active:brightness-90 focus-visible:border-amber-50/80 focus-visible:outline-none"
            onClick={confirm}
          >
            确定
          </button>
        </div>
      </div>
    </dialog>
  )
}
