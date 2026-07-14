import type { ReactNode } from 'react'

export type FileTransferRowState = 'queued' | 'transferring' | 'completed' | 'error'

export type FileTransferRowProps = {
  fileId: string
  name: string
  byteLength: number
  progress: number
  state: FileTransferRowState
  speedBytesPerSecond?: number
  etaSeconds?: number
  action?: ReactNode
}

const clampProgress = (progress: number) => {
  if (!Number.isFinite(progress)) return 0
  return Math.min(1, Math.max(0, progress))
}

const KiB = 1024
const MiB = 1024 * KiB

const formatSize = (bytes: number) => {
  if (bytes < KiB) return `${String(bytes)} B`
  if (bytes < MiB) return `${(bytes / KiB).toFixed(1)} KiB`
  return `${(bytes / MiB).toFixed(1)} MiB`
}

const formatSpeed = (bytesPerSecond: number): string => {
  if (bytesPerSecond < KiB) return `${Math.round(bytesPerSecond)} B/s`
  if (bytesPerSecond < MiB) return `${(bytesPerSecond / KiB).toFixed(1)} KiB/s`
  return `${(bytesPerSecond / MiB).toFixed(1)} MiB/s`
}

const formatEta = (seconds: number | undefined): string => {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return ''
  if (seconds < 60) return `${Math.ceil(seconds)}s`
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60)
    const s = Math.ceil(seconds % 60)
    return `${m}m${s}s`
  }
  const h = Math.floor(seconds / 3600)
  return `${h}h${Math.floor((seconds % 3600) / 60)}m`
}

const stateLabel = (state: FileTransferRowState, progress: number, speed?: number) => {
  if (state === 'completed') return '已完成'
  if (state === 'error') return '传输失败'
  if (state === 'transferring') return `${String(Math.round(progress * 100))}%`
  if (state === 'queued' && speed !== undefined && speed > 0) return ''
  return '等待传输'
}

export default function FileTransferRow({
  fileId,
  name,
  byteLength,
  progress,
  state,
  speedBytesPerSecond,
  etaSeconds,
  action,
}: FileTransferRowProps) {
  const normalized = state === 'completed' ? 1 : clampProgress(progress)
  const percentage = Math.round(normalized * 100)
  const showSpeed = state === 'transferring' && speedBytesPerSecond !== undefined && speedBytesPerSecond > 0
  const label = stateLabel(state, normalized, speedBytesPerSecond)

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
          action ? 'pr-12' : 'pr-3'
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
        <span className="flex shrink-0 flex-col items-end gap-0.5">
          <span className="text-xs tabular-nums text-amber-50/60">
            {label}
          </span>
          {showSpeed && (
            <span className="text-[10px] tabular-nums text-amber-50/40">
              {formatSpeed(speedBytesPerSecond!)}
              {etaSeconds !== undefined && etaSeconds > 0 && ` · ${formatEta(etaSeconds)}`}
            </span>
          )}
        </span>
      </div>
      {action && (
        <div
          data-testid={`file-transfer-action-${fileId}`}
          className="absolute inset-y-0 right-0 z-20 flex items-center rounded-r-lg"
        >
          {action}
        </div>
      )}
    </div>
  )
}
