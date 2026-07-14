import { useEffect, useRef, useState } from 'react'
import {
  MAX_FILE_BATCH_BYTES,
  MAX_FILE_COUNT,
  type PublicVisitor,
} from '@p2p/contracts'
import type { FileSelection } from '../features/transfer/file-selection'
import {
  createPastedTextFile,
  readPasteCandidate,
  type PasteCandidate,
} from '../features/transfer/paste-upload'
import {
  aggregateFileProgress,
  isTransferLocked,
  type OutgoingActivity,
} from '../features/transfer/ui-state'
import FileTransferRow from './FileTransferRow'
import PasteConfirmDialog from './PasteConfirmDialog'
import RecipientPickerDialog from './RecipientPickerDialog'
import TransferPeerFlow from './TransferPeerFlow'

const MEBIBYTE_BYTES = 1024 * 1024
const MAX_FILE_BATCH_MEBIBYTES = MAX_FILE_BATCH_BYTES / MEBIBYTE_BYTES

export type TransferPanelProps = {
  visitor: PublicVisitor
  receivers: PublicVisitor[]
  activity?: OutgoingActivity
  files: FileSelection[]
  selectionError: string
  fileSpeedData?: Record<string, { speed: number; eta: number | undefined }>
  onFilesAdded(files: readonly File[]): boolean
  onFileRemoved(fileId: string): void
  onSendFiles(peerIds: ReadonlyArray<string>): Promise<void>
  onCancel(): void
  onRetry?(): Promise<void>
  onDismissActivity?(): void
}

const terminalErrorProgress = (
  activity: OutgoingActivity,
  fileId: string,
) => {
  const file = activity.files[fileId]
  if (!file) return 0

  const acceptedProgress = activity.peerIds.flatMap(peerId => {
    const peer = activity.peers[peerId]
    const filePeer = file.peers[peerId]
    return peer?.accepted && filePeer ? [filePeer.progress] : []
  })

  return acceptedProgress.length > 0 ? Math.min(...acceptedProgress) : 0
}

export default function TransferPanel({
  visitor,
  receivers,
  activity,
  files,
  selectionError,
  fileSpeedData,
  onFilesAdded,
  onFileRemoved,
  onSendFiles,
  onCancel,
  onRetry,
  onDismissActivity,
}: TransferPanelProps) {
  const [submitting, setSubmitting] = useState(false)
  const [sendError, setSendError] = useState('')
  const [dragActive, setDragActive] = useState(false)
  const [selectedReceiverIds, setSelectedReceiverIds] = useState<string[] | undefined>()
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pasteCandidate, setPasteCandidate] = useState<PasteCandidate>()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const pickerTriggerRef = useRef<HTMLButtonElement>(null)
  const terminal = activity?.phase === 'complete' || activity?.phase === 'error'
  const activeTransfer = Boolean(activity && !terminal)
  const connectedCount = receivers.length
  const selectedIds = selectedReceiverIds ?? receivers.map(receiver => receiver.id)
  const selectedReadyReceivers = receivers.filter(receiver => selectedIds.includes(receiver.id))
  const selectedCount = selectedReadyReceivers.length
  const locked = isTransferLocked({ activity }) || submitting
  const pickerLocked = activeTransfer || submitting
  const canSend = selectedCount > 0 && files.length > 0 && !locked
  const connectedLabel = `${String(connectedCount)} 位接收者已连接`
  const showClearFiles = files.length > 0
  const fileSubmitLabel = files.length === 0
    ? '选择文件'
    : selectedCount === 0
      ? connectedCount === 0 ? '暂无接收者连接' : '请选择接收者'
      : `发送 ${String(files.length)} 项`
  const activePeerIds = new Set(activity?.peerIds ?? [])
  const flowReceivers = activity
    ? receivers.filter(receiver => activePeerIds.has(receiver.id))
    : receivers
  const flowPhase = activity?.phase ?? 'idle'

  useEffect(() => {
    if (selectedReceiverIds === undefined) return
    const nextIds = receivers
      .filter(receiver => selectedReceiverIds.includes(receiver.id))
      .map(receiver => receiver.id)
    if (nextIds.length === selectedReceiverIds.length
      && nextIds.every((id, index) => id === selectedReceiverIds[index])) {
      return
    }
    setSelectedReceiverIds(nextIds)
  }, [receivers, selectedReceiverIds])

  const restorePickerFocus = () => {
    window.setTimeout(() => pickerTriggerRef.current?.focus(), 0)
  }

  const handleFileSend = async () => {
    if (!canSend) return
    setSubmitting(true)
    setSendError('')
    try {
      await onSendFiles(selectedReadyReceivers.map(receiver => receiver.id))
    } catch (error) {
      setSendError(error instanceof Error ? error.message : '无法发送文件，请稍后重试。')
    } finally {
      setSubmitting(false)
    }
  }

  const handleRetry = async () => {
    if (!onRetry || submitting) return
    setSubmitting(true)
    setSendError('')
    try {
      await onRetry()
    } catch (error) {
      setSendError(error instanceof Error ? error.message : '无法重试传输，请稍后重试。')
    } finally {
      setSubmitting(false)
    }
  }

  const handleDismissActivity = () => {
    setSendError('')
    onDismissActivity?.()
  }

  const handleClearFiles = () => {
    if (locked) return
    for (const selection of files) onFileRemoved(selection.fileId)
  }

  const addFiles = (nextFiles: FileList | readonly File[] | null) => {
    if (!nextFiles || locked) return
    onFilesAdded(Array.from(nextFiles))
  }

  const handlePasteConfirm = () => {
    if (!pasteCandidate || locked) return
    const nextFiles = pasteCandidate.kind === 'files'
      ? pasteCandidate.files
      : [createPastedTextFile(pasteCandidate.text, files.map(selection => selection.file.name))]
    if (onFilesAdded(nextFiles)) setPasteCandidate(undefined)
  }

  const activityLabel = !activity
    ? connectedLabel
    : activity.kind === 'file'
      ? activity.phase === 'requesting'
        ? '正在等待接收方确认文件'
        : activity.phase === 'transferring'
          ? '正在传输文件'
          : activity.phase === 'complete'
            ? '文件传输完成'
            : '文件传输结束，但有接收方未完成'
      : activity.phase === 'complete'
        ? '传输完成'
        : activity.phase === 'error'
          ? '传输结束，但有接收方未完成'
          : '正在传输'

  return (
    <section
      className="native-scrollbar flex max-h-[calc(100svh-2rem)] w-[calc(100vw-2rem)] max-w-xl flex-col gap-5 overflow-y-auto py-0.5 sm:gap-6"
      aria-label="发送内容"
    >
      <div className="flex justify-end">
        <div className="flex w-full flex-nowrap items-center justify-between gap-2 sm:w-auto sm:justify-end sm:gap-3">
          <div className="shrink-0 whitespace-nowrap text-[11px] text-amber-50/60 tabular-nums sm:text-xs">
            {connectedLabel}
          </div>
           <TransferPeerFlow
             sender={visitor}
             receivers={flowReceivers}
             phase={flowPhase}
             accessibleLabel={activityLabel}
             onClick={receivers.length > 0 && !pickerLocked
               ? () => setPickerOpen(true)
               : undefined}
             selectedCount={selectedCount}
             triggerRef={pickerTriggerRef}
           />
        </div>
      </div>

      {(sendError || selectionError) && (
        <div className="flex items-center gap-2 rounded-xl border border-amber-50/15 bg-white/5 px-4 py-2.5 text-xs text-amber-50/70" role="alert">
          <span className="material-symbols-outlined shrink-0" style={{ fontSize: '16px' }} aria-hidden="true">warning</span>
          <span className="min-w-0 flex-1">{sendError || selectionError}</span>
          {sendError && (
            <button
              type="button"
              className="flex size-11 shrink-0 items-center justify-center rounded-lg border border-transparent text-amber-50/50 transition-colors hover:text-amber-50/80 focus-visible:border-accent focus-visible:outline-none"
              onClick={() => setSendError('')}
              aria-label="关闭错误提示"
            >
              <span className="material-symbols-outlined" style={{ fontSize: '16px' }} aria-hidden="true">close</span>
            </button>
          )}
        </div>
      )}

      <div
            role="button"
            tabIndex={locked ? -1 : 0}
            aria-label="上传要传输的内容"
            aria-disabled={locked}
            className={`flex min-h-52 flex-col rounded-xl border-2 border-dashed px-3 py-3 transition-colors focus-visible:border-accent focus-visible:outline-none sm:min-h-56 ${
              dragActive ? 'border-accent' : 'border-amber-50/15'
            } ${locked ? 'cursor-default' : 'cursor-pointer hover:border-amber-50/30'}`}
            onClick={event => {
              if (event.target === fileInputRef.current || locked) return
              fileInputRef.current?.click()
            }}
            onKeyDown={event => {
              if (locked || (event.key !== 'Enter' && event.key !== ' ')) return
              event.preventDefault()
              fileInputRef.current?.click()
            }}
            onDragEnter={event => {
              event.preventDefault()
              if (!locked) setDragActive(true)
            }}
            onDragOver={event => event.preventDefault()}
            onDragLeave={event => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                setDragActive(false)
              }
            }}
            onDrop={event => {
              event.preventDefault()
              setDragActive(false)
              addFiles(event.dataTransfer.files)
            }}
            onPaste={event => {
              if (locked) return
              const candidate = readPasteCandidate(event.clipboardData)
              if (!candidate) return
              event.preventDefault()
              setSendError('')
              setPasteCandidate(candidate)
            }}
          >
            {files.length === 0 ? (
              <div className="flex flex-1 flex-col items-center justify-center px-5 text-center">
                <span className="material-symbols-outlined text-amber-50/30" style={{ fontSize: '28px' }} aria-hidden="true">upload_file</span>
                <div className="mt-3 text-sm text-amber-50/70">拖拽文件到这里、点击选择，或粘贴内容</div>
                <p className="mt-2 text-xs leading-5 text-amber-50/50">
                  一次最多 {String(MAX_FILE_COUNT)} 个文件，总计不超过 {String(MAX_FILE_BATCH_MEBIBYTES)} MiB
                </p>
              </div>
            ) : (
              <div className="flex flex-1 flex-col gap-2" onClick={event => event.stopPropagation()}>
                <div
                  className="native-scrollbar max-h-52 space-y-2 overflow-y-auto overscroll-contain pr-1 sm:max-h-56"
                  data-testid="selected-file-scroll"
                >
                  {files.map(selection => {
                    const presentation = activity?.files[selection.fileId]
                    const progress = presentation
                      ? presentation.state === 'error'
                        ? terminalErrorProgress(activity, selection.fileId)
                        : aggregateFileProgress(activity, selection.fileId)
                      : 0
                    const state = presentation?.state ?? 'queued'
                    const speedInfo = fileSpeedData?.[selection.fileId]
                    return (
                      <FileTransferRow
                        key={selection.fileId}
                        fileId={selection.fileId}
                        name={selection.file.name}
                        byteLength={selection.file.size}
                        progress={progress}
                        state={state}
                        speedBytesPerSecond={speedInfo?.speed}
                        etaSeconds={speedInfo?.eta}
                        action={!locked ? (
                          <button
                            type="button"
                            className="flex size-11 shrink-0 items-center justify-center rounded-full text-amber-50/50 transition-colors hover:bg-white/5 hover:text-amber-50 focus-visible:bg-white/5 focus-visible:text-amber-50 focus-visible:outline-none"
                            onClick={event => {
                              event.stopPropagation()
                              onFileRemoved(selection.fileId)
                            }}
                            aria-label={`移除 ${selection.file.name}`}
                          >
                            <span className="material-symbols-outlined" style={{ fontSize: '16px' }} aria-hidden="true">close</span>
                          </button>
                        ) : undefined}
                      />
                    )
                  })}
                </div>
                {!locked && (
                  <button
                    type="button"
                    className="flex min-h-11 items-center justify-center gap-1.5 rounded-lg border border-transparent text-xs text-amber-50/60 transition-colors hover:text-amber-50/80 focus-visible:border-accent focus-visible:outline-none"
                    onClick={event => {
                      event.stopPropagation()
                      fileInputRef.current?.click()
                    }}
                  >
                    <span className="material-symbols-outlined" style={{ fontSize: '16px' }} aria-hidden="true">add</span>
                    添加更多内容
                  </button>
                )}
              </div>
            )}
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              disabled={locked}
              onChange={event => {
                addFiles(event.target.files)
                event.target.value = ''
              }}
            />
          </div>

      {activity && !terminal ? (
        <button
          type="button"
          className="flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-amber-50/15 bg-transparent px-4 text-sm text-amber-50/60 transition-colors hover:bg-white/5 hover:text-amber-50/80 focus-visible:border-accent focus-visible:outline-none disabled:cursor-not-allowed disabled:text-amber-50/30"
          onClick={onCancel}
        >
          取消传输
        </button>
      ) : terminal ? (
        <>
          <div
            className="rounded-xl border border-amber-50/15 bg-white/5 px-4 py-3"
            role={activity.phase === 'error' ? 'alert' : 'status'}
            aria-live="polite"
          >
            <p className="text-sm text-amber-50/80">
              {activity.phase === 'complete' ? '传输已完成' : '传输未完成'}
            </p>
            <p className="mt-1 text-xs leading-5 text-amber-50/55">
              {summarizePeerOutcomes(activity)}
            </p>
          </div>
          <div className="grid w-full grid-cols-2 gap-3">
            <button
              type="button"
              className="min-h-11 rounded-xl border border-accent bg-accent px-4 text-sm text-white/90 transition-[filter,border-color] hover:brightness-110 active:brightness-90 focus-visible:border-amber-50/80 focus-visible:outline-none"
              onClick={() => { void handleRetry() }}
              disabled={!onRetry}
            >
              再次发送
            </button>
            <button
              type="button"
              className="min-h-11 rounded-xl border border-amber-50/15 bg-transparent px-4 text-sm text-amber-50/60 transition-colors hover:bg-white/5 hover:text-amber-50/80 focus-visible:border-accent focus-visible:outline-none"
               onClick={handleDismissActivity}
            >
              关闭结果
            </button>
          </div>
        </>
      ) : (
        <div className="flex w-full items-center gap-3">
          {showClearFiles && (
            <button
              type="button"
              className="flex min-h-11 shrink-0 items-center justify-center rounded-xl border border-amber-50/15 bg-transparent px-4 text-sm text-amber-50/60 transition-colors hover:bg-white/5 hover:text-amber-50/80 focus-visible:border-accent focus-visible:outline-none disabled:cursor-not-allowed disabled:border-amber-50/10 disabled:text-amber-50/25"
              disabled={locked}
              onClick={handleClearFiles}
            >
              清空
            </button>
          )}
            <button
              type="button"
              className={`flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl border border-transparent px-4 text-sm transition-[filter,color,background-color,border-color] focus-visible:border-amber-50/80 focus-visible:outline-none ${
              canSend
                ? 'cursor-pointer bg-accent text-white/90 hover:brightness-110 active:brightness-90'
                : 'cursor-not-allowed bg-white/5 text-amber-50/30'
            }`}
            disabled={!canSend}
            onClick={() => { void handleFileSend() }}
          >
            {submitting && (
              <span className="material-symbols-outlined motion-safe:animate-spin" style={{ fontSize: '16px' }} aria-hidden="true">progress_activity</span>
            )}
            {fileSubmitLabel}
          </button>
        </div>
      )}

      {pickerOpen && (
        <RecipientPickerDialog
          receivers={receivers}
          selectedIds={selectedIds}
          onConfirm={ids => {
            setSelectedReceiverIds(ids)
            setPickerOpen(false)
            restorePickerFocus()
          }}
          onClose={() => {
            setPickerOpen(false)
            restorePickerFocus()
          }}
        />
      )}
      <PasteConfirmDialog
        candidate={pasteCandidate}
        onConfirm={handlePasteConfirm}
        onCancel={() => setPasteCandidate(undefined)}
      />
    </section>
  )
}

const summarizePeerOutcomes = (activity: OutgoingActivity) => {
  const counts = activity.peerIds.reduce<Record<string, number>>((result, peerId) => {
    const outcome = activity.peers[peerId]?.outcome
    if (!outcome) return result
    result[outcome] = (result[outcome] ?? 0) + 1
    return result
  }, {})
  const labels = [
    ['completed', '完成'],
    ['rejected', '拒绝'],
    ['cancelled', '取消'],
    ['failed', '失败'],
    ['timed-out', '超时'],
  ] as const
  const summary = labels.flatMap(([key, label]) => {
    const count = counts[key]
    return count ? [`${label} ${String(count)}`] : []
  })
  return summary.length > 0 ? summary.join(' · ') : '正在整理接收结果'
}
