import { useEffect, useId, useMemo, useRef } from 'react'
import type { PasteCandidate } from '../features/transfer/paste-upload'

export type PasteConfirmDialogProps = {
  candidate?: PasteCandidate
  onConfirm(): void
  onCancel(): void
}

const formatByteLength = (byteLength: number) => {
  if (byteLength < 1024) return `${byteLength} B`
  if (byteLength < 1024 * 1024) return `${(byteLength / 1024).toFixed(1)} KB`

  return `${(byteLength / (1024 * 1024)).toFixed(1)} MB`
}

export default function PasteConfirmDialog({
  candidate,
  onConfirm,
  onCancel,
}: PasteConfirmDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const cancelButtonRef = useRef<HTMLButtonElement>(null)
  const closingRef = useRef(false)
  const titleId = useId()
  const requestKey = useMemo(() => {
    if (!candidate) return 'empty'

    if (candidate.kind === 'files') {
      return `files:${candidate.files
        .map(file => `${file.name}:${file.size}:${file.lastModified}`)
        .join('\u0000')}`
    }

    return `text:${candidate.text.length}`
  }, [candidate])

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog || !candidate) return undefined

    closingRef.current = false
    if (!dialog.open) dialog.showModal()
    cancelButtonRef.current?.focus()

    return () => {
      if (dialog.open) dialog.close()
    }
  }, [candidate, requestKey])

  if (!candidate) return null

  const closeAnd = (callback: () => void) => {
    if (closingRef.current) return

    closingRef.current = true
    dialogRef.current?.close()
    callback()
  }

  const totalBytes = candidate.kind === 'files'
    ? candidate.files.reduce((total, file) => total + file.size, 0)
    : 0
  const textPreview = candidate.kind === 'text'
    ? candidate.text.length > 200
      ? `${candidate.text.slice(0, 200)}…`
      : candidate.text
    : ''

  return (
    <dialog
      ref={dialogRef}
      data-testid="paste-confirm-dialog"
      className="incoming-transfer-dialog m-auto max-h-[calc(100svh-2rem)] w-[calc(100%-2rem)] max-w-sm overflow-y-auto rounded-xl border border-amber-50/15 bg-surface-elevated p-0 text-amber-50/80 backdrop:bg-black/60"
      aria-modal="true"
      aria-labelledby={titleId}
      tabIndex={-1}
      onCancel={event => {
        event.preventDefault()
        closeAnd(onCancel)
      }}
    >
      <div className="p-5 sm:p-6">
        <h2 id={titleId} className="text-sm font-normal text-amber-50/80">
          确认添加粘贴内容
        </h2>
        <p className="mt-1 text-xs leading-5 text-amber-50/50">
          内容只会加入传输列表，确认后仍需手动点击发送。
        </p>

        {candidate.kind === 'files' ? (
          <div className="mt-5">
            <p className="text-sm text-amber-50/75">
              {candidate.files.length} 个文件 · {formatByteLength(totalBytes)}
            </p>
            <ul
              className="native-scrollbar mt-3 max-h-52 space-y-2 overflow-y-auto overscroll-contain"
              aria-label="待添加文件"
            >
              {candidate.files.map((file, index) => (
                <li
                  key={`${file.name}-${file.size}-${file.lastModified}-${index}`}
                  className="flex min-w-0 items-center justify-between gap-3 rounded-lg bg-white/5 px-3 py-2"
                >
                  <span className="min-w-0 truncate text-sm text-amber-50/80">{file.name}</span>
                  <span className="shrink-0 text-xs tabular-nums text-amber-50/45">
                    {formatByteLength(file.size)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <div className="mt-5">
            <div className="flex items-center justify-between gap-3">
              <span className="min-w-0 truncate text-sm text-amber-50/80">粘贴内容.txt</span>
              <span className="shrink-0 text-xs tabular-nums text-amber-50/50">
                {candidate.text.length} 个字符
              </span>
            </div>
            <pre className="mt-3 max-h-52 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-white/5 px-3 py-3 text-sm leading-6 text-amber-50/70">
              {textPreview}
            </pre>
          </div>
        )}

        <div className="mt-5 grid grid-cols-2 gap-2">
          <button
            ref={cancelButtonRef}
            type="button"
            className="min-h-11 rounded-xl border border-amber-50/15 px-4 text-sm text-amber-50/60 transition-colors hover:bg-white/5 hover:text-amber-50/80 focus-visible:border-accent focus-visible:outline-none"
            onClick={() => closeAnd(onCancel)}
          >
            取消
          </button>
          <button
            type="button"
            className="min-h-11 rounded-xl border border-accent bg-accent px-4 text-sm text-white/90 transition-[filter,border-color] hover:brightness-110 active:brightness-90 focus-visible:border-amber-50/80 focus-visible:outline-none"
            onClick={() => closeAnd(onConfirm)}
          >
            添加到传输列表
          </button>
        </div>
      </div>
    </dialog>
  )
}
