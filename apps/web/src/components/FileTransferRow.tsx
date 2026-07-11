import type { ReactNode } from 'react'

export type FileTransferRowState = 'queued' | 'transferring' | 'completed' | 'error'

export type FileTransferRowProps = {
  fileId: string
  name: string
  byteLength: number
  progress: number
  state: FileTransferRowState
  action?: ReactNode
}

const clampProgress = (progress: number) => {
  if (!Number.isFinite(progress)) return 0
  return Math.min(1, Math.max(0, progress))
}

const formatSize = (bytes: number) => {
  if (bytes < 1024) return `${String(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

const stateLabel = (state: FileTransferRowState, progress: number) => {
  if (state === 'completed') return '已完成'
  if (state === 'error') return '传输失败'
  if (state === 'transferring') return `${String(Math.round(progress * 100))}%`
  return '等待传输'
}

export default function FileTransferRow({
  fileId,
  name,
  byteLength,
  progress,
  state,
  action,
}: FileTransferRowProps) {
  const normalized = state === 'completed' ? 1 : clampProgress(progress)
  const percentage = Math.round(normalized * 100)
  const label = stateLabel(state, normalized)

  return (
    <div
      data-testid={`file-transfer-row-${fileId}`}
      className="relative overflow-hidden rounded-lg bg-white/5"
    >
      <div
        className="absolute inset-y-0 left-0 bg-accent/15 motion-safe:transition-[width] motion-safe:duration-150"
        style={{ width: `${String(percentage)}%` }}
        role="progressbar"
        aria-label={`${name} 传输进度`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percentage}
        aria-valuetext={label}
      />
      <div
        data-testid={`file-transfer-content-${fileId}`}
        className={`relative z-10 flex min-h-11 items-center gap-3 py-2 pl-3 ${
          action ? 'pr-14' : 'pr-3'
        }`}
      >
        <span
          className="material-symbols-outlined shrink-0 text-amber-50/40"
          style={{ fontSize: '16px' }}
          aria-hidden="true"
        >
          description
        </span>
        <span
          className="min-w-0 flex-1 truncate text-xs text-amber-50/75"
          title={name}
        >
          {name}
        </span>
        <span className="shrink-0 text-xs tabular-nums text-amber-50/50">
          {formatSize(byteLength)}
        </span>
        <span className="w-16 shrink-0 text-right text-xs tabular-nums text-amber-50/60">
          {label}
        </span>
      </div>
      {action && (
        <div
          data-testid={`file-transfer-action-${fileId}`}
          className="absolute inset-y-0 right-0 z-20 flex items-center"
        >
          {action}
        </div>
      )}
    </div>
  )
}
