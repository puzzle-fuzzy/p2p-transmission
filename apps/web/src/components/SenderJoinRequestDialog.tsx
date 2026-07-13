import { useEffect, useId, useRef, useState } from 'react'
import type { RoomJoinRequestSummary } from '../shared/contracts'
import Avatar from './Avatar'

export type SenderJoinRequestDialogProps = {
  request: RoomJoinRequestSummary
  remainingCount: number
  pendingDecision?: 'approve' | 'reject'
  onApprove(requestId: string): void
  onReject(requestId: string): void
}

export default function SenderJoinRequestDialog({
  request,
  remainingCount,
  pendingDecision,
  onApprove,
  onReject,
}: SenderJoinRequestDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const rejectButtonRef = useRef<HTMLButtonElement>(null)
  const previousPendingDecisionRef = useRef(pendingDecision)
  const [localDecision, setLocalDecision] = useState<'approve' | 'reject'>()
  const titleId = useId()
  const descriptionId = useId()
  const effectiveDecision = pendingDecision ?? localDecision
  const decisionPending = effectiveDecision !== undefined

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return undefined

    setLocalDecision(undefined)
    if (!dialog.open) dialog.showModal()
    rejectButtonRef.current?.focus()

    return () => {
      if (dialog.open) dialog.close()
    }
  }, [request.requestId])

  useEffect(() => {
    if (
      previousPendingDecisionRef.current !== undefined
      && pendingDecision === undefined
    ) {
      setLocalDecision(undefined)
    }
    previousPendingDecisionRef.current = pendingDecision
  }, [pendingDecision])

  const decide = (decision: 'approve' | 'reject') => {
    if (decisionPending) return

    setLocalDecision(decision)
    if (decision === 'approve') onApprove(request.requestId)
    else onReject(request.requestId)
  }

  return (
    <dialog
      ref={dialogRef}
      className="incoming-transfer-dialog m-auto max-h-[calc(100svh-2rem)] w-[calc(100%-2rem)] max-w-sm overflow-y-auto rounded-xl border border-amber-50/15 bg-surface-elevated p-0 text-amber-50/80 backdrop:bg-black/60"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      tabIndex={-1}
      onCancel={event => event.preventDefault()}
    >
      <div className="p-5 sm:p-6">
        <div className="flex min-w-0 items-center gap-3">
          <Avatar
            seed={request.visitor.avatarSeed}
            label={request.visitor.displayName}
            className="size-11 shrink-0"
          />
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-sm font-normal text-amber-50/80">
              加入申请
            </h2>
            <p className="mt-1 truncate text-sm text-amber-50/80">
              {request.visitor.displayName}
            </p>
          </div>
        </div>

        <div className="mt-5 rounded-lg bg-white/5 px-4 py-4">
          <p id={descriptionId} className="text-sm text-amber-50/70">
            请求加入房间
          </p>
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
            <span className="font-mono text-sm tracking-[0.15em] text-amber-50/80">
              房间 {request.roomCode}
            </span>
            {remainingCount > 0 && (
              <span className="text-xs text-amber-50/50">还有 {remainingCount} 个申请</span>
            )}
          </div>
        </div>

        <div className="mt-5 grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-2">
          <button
            ref={rejectButtonRef}
            type="button"
            className="min-h-11 rounded-xl border border-amber-50/15 px-3 text-sm tracking-wider text-amber-50/60 transition-colors hover:bg-white/5 hover:text-amber-50/80 focus-visible:border-accent focus-visible:outline-none disabled:cursor-wait disabled:text-amber-50/20"
            disabled={decisionPending}
            onClick={() => decide('reject')}
          >
            {effectiveDecision === 'reject' ? '拒绝中…' : '拒绝'}
          </button>
          <button
            type="button"
            className="min-h-11 rounded-xl border border-accent bg-accent px-4 text-sm tracking-wider text-white/90 transition-[filter,border-color] hover:brightness-110 active:brightness-90 focus-visible:border-amber-50/80 focus-visible:outline-none disabled:cursor-wait disabled:brightness-75"
            disabled={decisionPending}
            onClick={() => decide('approve')}
          >
            {effectiveDecision === 'approve' ? '允许中…' : '允许加入'}
          </button>
        </div>
      </div>
    </dialog>
  )
}
