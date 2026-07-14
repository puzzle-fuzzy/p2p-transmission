import type { PublicVisitor } from '../shared/contracts'
import TransferPeerFlow from './TransferPeerFlow'

export type ReceiverPanelState =
  | { status: 'waiting' }
  | { status: 'receiving' }
  | { status: 'error'; message?: string }

export type ReceiverPanelProps = {
  visitor: PublicVisitor
  sender?: PublicVisitor
  receivers: PublicVisitor[]
  connected: boolean
  state: ReceiverPanelState
}

const statusCopy = {
  waiting: {
    label: '等待传输',
    title: '等待对方发送',
    description: '保持当前页面打开，收到内容后会在弹窗中显示。',
    icon: 'sensors',
  },
  receiving: {
    label: '接收中',
    title: '正在接收文件',
    description: '请保持当前页面打开，实际进度会显示在文件弹窗中。',
    icon: 'sync',
  },
  error: {
    label: '连接中断',
    title: '传输连接已中断',
    description: '请重新加入房间后再试。',
    icon: 'link_off',
  },
} as const

export default function ReceiverPanel({
  visitor,
  sender,
  receivers,
  connected,
  state,
}: ReceiverPanelProps) {
  const copy = statusCopy[state.status]
  const description = state.status === 'error' && state.message
    ? state.message
    : copy.description
  const flowPhase = state.status === 'error'
    ? 'error'
    : state.status === 'receiving'
      ? 'transferring'
      : connected
        ? 'idle'
        : 'connecting'
  const flowLabel = state.status === 'error'
    ? '传输连接已中断'
    : state.status === 'receiving'
      ? '正在接收来自发送者的文件'
      : connected
        ? `${String(receivers.length)} 位接收者在房间内，点对点已连接`
        : '正在建立点对点连接'

  return (
    <section
      className="w-[calc(100vw-2rem)] max-w-xl"
      aria-label="接收状态"
    >
      <TransferPeerFlow
        sender={sender}
        receivers={receivers}
        highlightedReceiverId={visitor.id}
        phase={flowPhase}
        accessibleLabel={flowLabel}
      />

      <div className="mt-6 flex min-h-56 flex-col items-center justify-center rounded-xl border border-amber-50/15 px-5 text-center">
        <span
          className={`material-symbols-outlined text-amber-50/40 ${state.status === 'receiving' ? 'motion-safe:animate-spin' : ''}`}
          style={{ fontSize: '26px' }}
          aria-hidden="true"
        >
          {copy.icon}
        </span>
        <h2 className="mt-3 text-sm font-normal text-amber-50/70">{copy.title}</h2>
        <p className="mt-2 max-w-sm text-xs leading-5 text-amber-50/50">
          {description}
        </p>
      </div>
    </section>
  )
}
