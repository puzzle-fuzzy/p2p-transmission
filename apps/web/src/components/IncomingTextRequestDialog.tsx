import { useEffect, useId, useRef, useState } from 'react'
import type { PublicVisitor } from '../shared/contracts'
import Avatar from './Avatar'

export type IncomingTextRequest = {
  transferId: string
  sender: PublicVisitor
  characterCount: number
  byteLength: number
}

export type IncomingTextRequestStatus = 'pending' | 'receiving'

export type IncomingTextRequestDialogProps = {
  request: IncomingTextRequest
  status: IncomingTextRequestStatus
  onAccept(): void
  onReject(): void
}

const formatByteLength = (byteLength: number) => {
  if (byteLength < 1024) return `${byteLength} B`

  return `${(byteLength / 1024).toFixed(1)} KB`
}

export default function IncomingTextRequestDialog({
  request,
  status,
  onAccept,
  onReject,
}: IncomingTextRequestDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const rejectButtonRef = useRef<HTMLButtonElement>(null)
  const decisionMadeRef = useRef(false)
  const [decisionMade, setDecisionMade] = useState(false)
  const titleId = useId()
  const descriptionId = useId()

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return undefined

    decisionMadeRef.current = false
    setDecisionMade(false)
    dialog.showModal()
    rejectButtonRef.current?.focus()

    return () => {
      if (dialog.open) dialog.close()
    }
  }, [request.transferId])

  const rejectOnce = () => {
    if (status !== 'pending' || decisionMadeRef.current) return

    decisionMadeRef.current = true
    setDecisionMade(true)
    dialogRef.current?.close()
    onReject()
  }

  const acceptOnce = () => {
    if (status !== 'pending' || decisionMadeRef.current) return

    decisionMadeRef.current = true
    setDecisionMade(true)
    onAccept()
  }

  return (
    <dialog
      ref={dialogRef}
      className="incoming-transfer-dialog m-auto w-[calc(100%-2rem)] max-w-md max-h-[calc(100svh-2rem)] overflow-y-auto rounded-xl border border-amber-50/15 bg-[#373737] p-0 text-amber-50/80 backdrop:bg-black/50"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onCancel={event => {
        event.preventDefault()
        rejectOnce()
      }}
    >
      <div className="p-5 sm:p-6">
        {status === 'pending' ? (
          <>
            <div className="flex items-start gap-3">
              <Avatar
                seed={request.sender.avatarSeed}
                label={request.sender.displayName}
                className="shrink-0"
              />
              <div className="min-w-0 flex-1">
                <h2 id={titleId} className="text-sm font-medium text-amber-50/80">
                  接收这段文本？
                </h2>
                <p className="mt-1 truncate text-xs text-amber-50/50">
                  来自 {request.sender.displayName}
                </p>
              </div>
            </div>

            <div className="mt-5 flex flex-wrap gap-x-4 gap-y-2 rounded-lg bg-white/5 px-3 py-2.5 text-xs text-amber-50/50">
              <span>{request.characterCount} 个字符</span>
              <span>{formatByteLength(request.byteLength)}</span>
            </div>

            <p id={descriptionId} className="mt-4 text-xs leading-5 text-amber-50/50">
              确认接收后，对方才会发送文本内容。拒绝后不会接收正文。
            </p>

            <div className="mt-6 grid grid-cols-1 gap-2 sm:grid-cols-2">
              <button
                ref={rejectButtonRef}
                type="button"
                className="min-h-11 rounded-xl border border-amber-50/15 px-4 text-sm text-amber-50/60 transition-colors hover:bg-white/5 hover:text-amber-50/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-[#373737] disabled:cursor-not-allowed disabled:text-amber-50/20"
                disabled={decisionMade}
                onClick={rejectOnce}
              >
                拒绝
              </button>
              <button
                type="button"
                className="min-h-11 rounded-xl bg-accent px-4 text-sm text-white/90 transition-[filter] hover:brightness-110 active:brightness-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-50/80 focus-visible:ring-offset-2 focus-visible:ring-offset-[#373737] disabled:cursor-not-allowed disabled:brightness-75"
                disabled={decisionMade}
                onClick={acceptOnce}
              >
                接收
              </button>
            </div>
          </>
        ) : (
          <div className="flex min-h-44 flex-col items-center justify-center px-2 py-5 text-center">
            <span
              className="material-symbols-outlined motion-safe:animate-spin text-amber-50/50"
              style={{ fontSize: '24px' }}
              aria-hidden="true"
            >
              progress_activity
            </span>
            <h2 id={titleId} className="mt-4 text-sm font-medium text-amber-50/80">
              正在接收…
            </h2>
            <p id={descriptionId} className="mt-2 text-xs leading-5 text-amber-50/50">
              请保持当前页面打开，文本到达后会显示在主面板中。
            </p>
          </div>
        )}
      </div>
    </dialog>
  )
}
