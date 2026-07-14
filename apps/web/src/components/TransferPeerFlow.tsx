import type { Ref } from 'react'
import type { PublicVisitor } from '../shared/contracts'
import Avatar from './Avatar'

export type TransferPeerFlowPhase =
  | 'connecting'
  | 'idle'
  | 'requesting'
  | 'transferring'
  | 'complete'
  | 'error'

export type TransferPeerFlowProps = {
  sender?: PublicVisitor
  receivers: PublicVisitor[]
  phase: TransferPeerFlowPhase
  accessibleLabel: string
  onClick?(): void
  selectedCount?: number
  triggerRef?: Ref<HTMLButtonElement>
}

const MAX_AVATAR_SLOTS = 5
const VISIBLE_BEFORE_TOTAL = MAX_AVATAR_SLOTS - 1

const StateTrack = ({ phase }: { phase: TransferPeerFlowPhase }) => {
  if (phase === 'connecting' || phase === 'requesting') {
    return (
      <span className="flex items-center gap-1.5">
        <span className="transfer-peer-flow__dot size-1 rounded-full bg-accent" />
        <span className="transfer-peer-flow__dot size-1 rounded-full bg-accent" />
        <span className="transfer-peer-flow__dot size-1 rounded-full bg-accent" />
      </span>
    )
  }

  if (phase === 'transferring') {
    return (
      <svg
        className="transfer-peer-flow__dash h-2 w-full text-accent"
        viewBox="0 0 100 2"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <line
          className="transfer-peer-flow__dash-line"
          x1="0"
          y1="1"
          x2="100"
          y2="1"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeDasharray="7 7"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    )
  }

  if (phase === 'error') {
    return (
      <span className="flex w-full items-center gap-2 text-amber-50/50">
        <span className="transfer-peer-flow__line h-px flex-1 bg-current" />
        <span
          className="material-symbols-outlined"
          style={{ fontSize: '15px' }}
          data-state-icon="link_off"
        >
          link_off
        </span>
        <span className="transfer-peer-flow__line h-px flex-1 bg-current" />
      </span>
    )
  }

  return (
    <span className="flex w-full items-center gap-2 text-amber-50/20">
      <span className="transfer-peer-flow__line h-px flex-1 bg-current" />
      {phase === 'complete' && (
        <span
          className="material-symbols-outlined text-accent"
          style={{ fontSize: '15px' }}
          data-state-icon="check"
        >
          check
        </span>
      )}
    </span>
  )
}

export default function TransferPeerFlow({
  sender,
  receivers,
  phase,
  accessibleLabel,
  onClick,
  selectedCount,
  triggerRef,
}: TransferPeerFlowProps) {
  const overflow = receivers.length > MAX_AVATAR_SLOTS
  const visibleReceivers = overflow
    ? receivers.slice(0, VISIBLE_BEFORE_TOTAL)
    : receivers
  const animated = phase === 'connecting'
    || phase === 'requesting'
    || phase === 'transferring'

  const visualFlow = (
    <div className="flex w-full min-w-0 items-center" aria-hidden="true">
      <span className="flex size-9 shrink-0 items-center" data-side="sender">
        {sender && (
          <Avatar
            seed={sender.avatarSeed}
            label={sender.displayName}
            className="shrink-0 max-sm:size-8!"
          />
        )}
      </span>

      <span className="flex min-w-8 flex-1 items-center justify-center px-3 sm:px-5">
        <StateTrack phase={phase} />
      </span>

      <span
        className="flex min-w-9 shrink-0 items-center justify-end pl-2"
        data-side="receivers"
      >
        {receivers.length === 0 ? (
          <span className="transfer-peer-flow__placeholder flex size-9 items-center justify-center rounded-full border border-amber-50/15 text-amber-50/50 max-sm:size-8!">
            <span className="material-symbols-outlined" style={{ fontSize: '17px' }}>
              person_add
            </span>
          </span>
        ) : (
          <>
            {visibleReceivers.map((receiver, index) => (
              <Avatar
                key={receiver.id}
                seed={receiver.avatarSeed}
                label={receiver.displayName}
                className={`shrink-0 max-sm:size-8! ${index === 0 ? '' : '-ml-2'}`}
              />
            ))}
            {overflow && (
              <span
                className="-ml-2 flex size-9 shrink-0 items-center justify-center rounded-full border-2 border-surface bg-white/10 px-1 text-[11px] tabular-nums text-amber-50/70 max-sm:size-8!"
                title={`共 ${String(receivers.length)} 位接收者`}
              >
                {receivers.length}
              </span>
            )}
          </>
        )}
      </span>
    </div>
  )

  return (
    <div
      className="transfer-peer-flow w-full min-w-0"
      data-active={animated ? 'true' : 'false'}
      data-phase={phase}
      role="status"
      aria-label={accessibleLabel}
      aria-live="polite"
      aria-atomic="true"
    >
      <span className="sr-only">
        {receivers.length === 0
          ? '暂无接收者'
          : `共 ${String(receivers.length)} 位接收者`}
      </span>
      {onClick ? (
        <button
          type="button"
          ref={triggerRef}
          className="min-h-11 w-full rounded-lg border border-transparent text-left transition-colors hover:bg-white/5 focus-visible:border-accent focus-visible:outline-none"
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
