import type { Ref } from 'react'
import type { PublicVisitor } from '../shared/contracts'
import Avatar from './Avatar'

export type TransferPeerFlowPhase =
  | 'idle'
  | 'requesting'
  | 'transferring'
  | 'complete'
  | 'error'

export type TransferPeerFlowProps = {
  sender: PublicVisitor
  receivers: PublicVisitor[]
  phase: TransferPeerFlowPhase
  accessibleLabel: string
  onClick?(): void
  selectedCount?: number
  triggerRef?: Ref<HTMLButtonElement>
}

const MAX_VISIBLE_RECEIVERS = 3

export default function TransferPeerFlow({
  sender,
  receivers,
  phase,
  accessibleLabel,
  onClick,
  selectedCount,
  triggerRef,
}: TransferPeerFlowProps) {
  const visibleReceivers = receivers.slice(0, MAX_VISIBLE_RECEIVERS)
  const overflow = Math.max(0, receivers.length - visibleReceivers.length)
  const active = phase === 'transferring'
  const hasReceivers = visibleReceivers.length > 0

  const visualFlow = (
    <div className="flex min-w-0 items-center gap-1 sm:gap-3" aria-hidden="true">
      <Avatar
        seed={sender.avatarSeed}
        label={sender.displayName}
        className="shrink-0 max-sm:size-8!"
      />

      {hasReceivers && (
        <>
          <span className="flex w-5 shrink-0 items-center justify-center sm:w-8" aria-hidden="true">
            {active ? (
              <span className="flex items-center gap-1 sm:gap-1.5">
                <span className="transfer-peer-flow__dot size-1 rounded-full bg-accent" />
                <span className="transfer-peer-flow__dot size-1 rounded-full bg-accent" />
                <span className="transfer-peer-flow__dot size-1 rounded-full bg-accent" />
              </span>
            ) : (
              <span className="transfer-peer-flow__line h-px w-full bg-amber-50/20" />
            )}
          </span>

          <span className="flex min-w-0 items-center pl-1 sm:pl-2">
            {visibleReceivers.map((receiver, index) => (
              <Avatar
                key={receiver.id}
                seed={receiver.avatarSeed}
                label={receiver.displayName}
                className={`shrink-0 max-sm:size-8! ${index === 0 ? '' : '-ml-2'}`}
              />
            ))}
            {overflow > 0 && (
              <span className="-ml-2 flex size-9 shrink-0 items-center justify-center rounded-full border-2 border-surface bg-white/10 text-[11px] tabular-nums text-amber-50/70 max-sm:size-8!">
                +{overflow}
              </span>
            )}
          </span>
        </>
      )}
    </div>
  )

  return (
    <div
      className="transfer-peer-flow flex min-w-0 items-center gap-3"
      data-active={active ? 'true' : 'false'}
      data-phase={phase}
      role="status"
      aria-label={accessibleLabel}
      aria-live="polite"
      aria-atomic="true"
    >
      {onClick ? (
        <button
          type="button"
          ref={triggerRef}
          className="min-h-11 min-w-0 rounded-lg border border-transparent text-left transition-colors hover:bg-white/5 focus-visible:border-accent focus-visible:outline-none disabled:cursor-not-allowed"
          onClick={onClick}
          aria-label={`选择接收者，已选择 ${String(selectedCount ?? receivers.length)} 位`}
          title="选择接收者"
        >
          {visualFlow}
        </button>
      ) : visualFlow}
    </div>
  )
}
