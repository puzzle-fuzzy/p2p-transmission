import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { PublicVisitor } from '../shared/contracts'
import Avatar from './Avatar'
import FileTransferRow from './FileTransferRow'

export type IncomingFileRequestItem = {
  fileId: string
  name: string
  byteLength: number
}

export type DownloadableReceivedFile = IncomingFileRequestItem & {
  url: string
}

export type IncomingFileRequestDialogState =
  | { status: 'pending' }
  | { status: 'receiving'; progressByFileId: Readonly<Record<string, number>> }
  | { status: 'received'; files: readonly DownloadableReceivedFile[] }
  | { status: 'error'; message?: string }

export type IncomingFileRequestDialogProps = {
  sender: PublicVisitor
  files: readonly IncomingFileRequestItem[]
  state: IncomingFileRequestDialogState
  onAccept(): void
  onReject(): void
  onCancel(): void
  onClose(): void
}

const formatByteLength = (byteLength: number) => {
  if (byteLength < 1024) return `${byteLength} B`
  if (byteLength < 1024 * 1024) return `${(byteLength / 1024).toFixed(1)} KB`

  return `${(byteLength / (1024 * 1024)).toFixed(1)} MB`
}

export default function IncomingFileRequestDialog({
  sender,
  files,
  state,
  onAccept,
  onReject,
  onCancel,
  onClose,
}: IncomingFileRequestDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const rejectButtonRef = useRef<HTMLButtonElement>(null)
  const cancelButtonRef = useRef<HTMLButtonElement>(null)
  const downloadAllButtonRef = useRef<HTMLButtonElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const decisionMadeRef = useRef(false)
  const closingRef = useRef(false)
  const [decisionMade, setDecisionMade] = useState(false)
  const titleId = useId()
  const descriptionId = useId()
  const requestKey = useMemo(
    () => `${sender.id}\u0000${files.map(file => file.fileId).join('\u0000')}`,
    [files, sender.id],
  )
  const totalBytes = files.reduce((total, file) => total + file.byteLength, 0)

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return undefined

    decisionMadeRef.current = false
    closingRef.current = false
    setDecisionMade(false)
    if (!dialog.open) dialog.showModal()

    return () => {
      if (dialog.open) dialog.close()
    }
  }, [requestKey])

  useEffect(() => {
    if (state.status === 'pending') {
      rejectButtonRef.current?.focus()
      return
    }

    if (state.status === 'receiving') {
      cancelButtonRef.current?.focus()
      return
    }

    if (state.status === 'received') {
      downloadAllButtonRef.current?.focus()
      return
    }

    closeButtonRef.current?.focus()
  }, [state.status])

  const rejectOnce = () => {
    if (state.status !== 'pending' || decisionMadeRef.current) return

    decisionMadeRef.current = true
    setDecisionMade(true)
    dialogRef.current?.close()
    onReject()
  }

  const acceptOnce = () => {
    if (state.status !== 'pending' || decisionMadeRef.current) return

    decisionMadeRef.current = true
    setDecisionMade(true)
    onAccept()
  }

  const cancelOnce = () => {
    if (state.status !== 'receiving' || closingRef.current) return

    closingRef.current = true
    dialogRef.current?.close()
    onCancel()
  }

  const closeOnce = () => {
    if (closingRef.current) return

    closingRef.current = true
    dialogRef.current?.close()
    onClose()
  }

  const downloadAll = () => {
    if (state.status !== 'received') return

    for (const file of state.files) {
      const link = document.createElement('a')
      link.href = file.url
      link.download = file.name
      link.rel = 'noopener'
      link.style.display = 'none'
      document.body.append(link)
      link.click()
      link.remove()
    }
  }

  const listedFiles = state.status === 'received' ? state.files : files
  const downloadableFiles = new Map<string, DownloadableReceivedFile>(
    state.status === 'received'
      ? state.files.map(file => [file.fileId, file] as const)
      : [],
  )

  return (
    <dialog
      ref={dialogRef}
      className="incoming-transfer-dialog m-auto max-h-[calc(100svh-2rem)] w-[calc(100%-2rem)] max-w-lg overflow-y-auto rounded-xl border border-amber-50/15 bg-[#373737] p-0 text-amber-50/80 backdrop:bg-black/60"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      tabIndex={-1}
      onCancel={event => {
        event.preventDefault()
        if (state.status === 'pending') rejectOnce()
        else if (state.status === 'receiving') cancelOnce()
        else closeOnce()
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
              收到文件
            </h2>
            <p id={descriptionId} className="mt-1 truncate text-xs text-amber-50/50">
              来自 {sender.displayName} · {files.length} 个文件 · {formatByteLength(totalBytes)}
            </p>
          </div>
        </div>

        <ul
          className="native-scrollbar mt-5 max-h-52 space-y-2 overflow-y-auto overscroll-contain sm:max-h-56"
          aria-label={state.status === 'received' ? '已接收文件' : '待接收文件'}
        >
          {listedFiles.map(file => {
            const progress = state.status === 'receiving'
              ? state.progressByFileId[file.fileId] ?? 0
              : state.status === 'received'
                ? 1
                : 0
            const fileState = state.status === 'received'
              ? 'completed'
              : state.status === 'error'
                ? 'error'
                : state.status === 'receiving'
                  ? progress >= 1
                    ? 'completed'
                    : progress > 0
                      ? 'transferring'
                      : 'queued'
                  : 'queued'
            const downloadable = downloadableFiles.get(file.fileId)

            return (
              <li key={file.fileId}>
                <FileTransferRow
                  fileId={file.fileId}
                  name={file.name}
                  byteLength={file.byteLength}
                  progress={progress}
                  state={fileState}
                  action={downloadable ? (
                    <a
                      href={downloadable.url}
                      download={downloadable.name}
                      aria-label={`下载 ${downloadable.name}`}
                      className="flex size-11 shrink-0 items-center justify-center text-amber-50/60 transition-colors hover:bg-white/5 hover:text-amber-50/80 focus-visible:bg-white/5 focus-visible:text-amber-50/80 focus-visible:outline-none"
                    >
                      <span className="material-symbols-outlined" style={{ fontSize: '17px' }} aria-hidden="true">download</span>
                    </a>
                  ) : undefined}
                />
              </li>
            )
          })}
        </ul>

        {state.status === 'error' && (
          <div className="mt-5 rounded-lg border border-amber-50/15 bg-white/5 px-4 py-3">
            <p className="text-sm text-amber-50/70">文件接收未完成</p>
            <p className="mt-1 text-xs leading-5 text-amber-50/50">
              {state.message ?? '连接已中断，请让发送者重新发送。'}
            </p>
          </div>
        )}

        {state.status === 'pending' && (
          <div className="mt-5 grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-2">
            <button
              ref={rejectButtonRef}
              type="button"
              className="min-h-11 rounded-xl border border-amber-50/15 px-4 text-sm tracking-[0.05em] text-amber-50/60 transition-colors hover:bg-white/5 hover:text-amber-50/80 focus-visible:border-accent focus-visible:outline-none disabled:cursor-not-allowed disabled:text-amber-50/20"
              disabled={decisionMade}
              onClick={rejectOnce}
            >
              拒绝
            </button>
            <button
              type="button"
              className="min-h-11 rounded-xl border border-accent bg-accent px-4 text-sm tracking-[0.05em] text-white/90 transition-[filter,border-color] hover:brightness-110 active:brightness-90 focus-visible:border-amber-50/80 focus-visible:outline-none disabled:cursor-not-allowed disabled:brightness-75"
              disabled={decisionMade}
              onClick={acceptOnce}
            >
              接收全部
            </button>
          </div>
        )}

        {state.status === 'receiving' && (
          <button
            ref={cancelButtonRef}
            type="button"
            className="mt-5 min-h-11 w-full rounded-xl border border-amber-50/15 px-4 text-sm tracking-[0.05em] text-amber-50/60 transition-colors hover:bg-white/5 hover:text-amber-50/80 focus-visible:border-accent focus-visible:outline-none"
            onClick={cancelOnce}
          >
            取消接收
          </button>
        )}

        {state.status === 'received' && (
          <div className="mt-5 grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-2">
            <button
              ref={closeButtonRef}
              type="button"
              className="min-h-11 rounded-xl border border-amber-50/15 px-4 text-sm tracking-[0.05em] text-amber-50/60 transition-colors hover:bg-white/5 hover:text-amber-50/80 focus-visible:border-accent focus-visible:outline-none"
              onClick={closeOnce}
            >
              关闭
            </button>
            <button
              ref={downloadAllButtonRef}
              type="button"
              className="min-h-11 rounded-xl border border-accent bg-accent px-4 text-sm tracking-[0.05em] text-white/90 transition-[filter,border-color] hover:brightness-110 active:brightness-90 focus-visible:border-amber-50/80 focus-visible:outline-none"
              onClick={downloadAll}
            >
              一键下载
            </button>
          </div>
        )}

        {state.status === 'error' && (
          <button
            ref={closeButtonRef}
            type="button"
            className="mt-5 min-h-11 w-full rounded-xl border border-amber-50/15 px-4 text-sm tracking-[0.05em] text-amber-50/60 transition-colors hover:bg-white/5 hover:text-amber-50/80 focus-visible:border-accent focus-visible:outline-none"
            onClick={closeOnce}
          >
            关闭
          </button>
        )}
      </div>
    </dialog>
  )
}
