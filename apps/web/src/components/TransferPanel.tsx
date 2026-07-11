import { useId, useRef, useState } from 'react'
import { MAX_TEXT_CHARACTERS, type PublicRoom, type PublicVisitor } from '@p2p/contracts'
import type { FileSelection } from '../features/transfer/file-selection'
import {
  aggregateFileProgress,
  isTransferLocked,
  type OutgoingActivity,
} from '../features/transfer/ui-state'
import Avatar from './Avatar'
import FileTransferRow from './FileTransferRow'
import TransferPeerFlow from './TransferPeerFlow'

type Tab = 'text' | 'file'

export type TransferPanelProps = {
  visitor: PublicVisitor
  room: PublicRoom
  receivers: PublicVisitor[]
  readyPeerCount: number
  activity?: OutgoingActivity
  files: FileSelection[]
  selectionError: string
  onFilesAdded(files: readonly File[]): void
  onFileRemoved(fileId: string): void
  onSendText(text: string): Promise<void>
  onSendFiles(): Promise<void>
  onCancel(): void
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
  room,
  receivers,
  readyPeerCount,
  activity,
  files,
  selectionError,
  onFilesAdded,
  onFileRemoved,
  onSendText,
  onSendFiles,
  onCancel,
}: TransferPanelProps) {
  const [tab, setTab] = useState<Tab>('text')
  const [text, setText] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [sendError, setSendError] = useState('')
  const [dragActive, setDragActive] = useState(false)
  const textTabRef = useRef<HTMLButtonElement>(null)
  const fileTabRef = useRef<HTMLButtonElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const tabId = useId()
  const connectedCount = Math.max(0, Math.trunc(readyPeerCount))
  const locked = isTransferLocked({ activity }) || submitting
  const canSendText = connectedCount > 0 && Boolean(text.trim()) && !locked
  const canSendFiles = connectedCount > 0 && files.length > 0 && !locked

  const selectTab = (nextTab: Tab, focus = false) => {
    if (locked) return
    setTab(nextTab)
    setSendError('')
    if (focus) {
      const target = nextTab === 'text' ? textTabRef.current : fileTabRef.current
      target?.focus()
    }
  }

  const handleTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    if (event.key === 'Home') {
      selectTab('text', true)
      return
    }
    if (event.key === 'End') {
      selectTab('file', true)
      return
    }

    const nextTab = event.key === 'ArrowLeft'
      ? tab === 'text' ? 'file' : 'text'
      : tab === 'file' ? 'text' : 'file'
    selectTab(nextTab, true)
  }

  const handleTextSend = async () => {
    if (!canSendText) return
    const snapshot = text
    setSubmitting(true)
    setSendError('')
    try {
      await onSendText(snapshot)
      setText(current => current === snapshot ? '' : current)
    } catch (error) {
      setSendError(error instanceof Error ? error.message : '无法发送文本，请稍后重试。')
    } finally {
      setSubmitting(false)
    }
  }

  const handleFileSend = async () => {
    if (!canSendFiles) return
    setSubmitting(true)
    setSendError('')
    try {
      await onSendFiles()
    } catch (error) {
      setSendError(error instanceof Error ? error.message : '无法发送文件，请稍后重试。')
    } finally {
      setSubmitting(false)
    }
  }

  const addFiles = (nextFiles: FileList | readonly File[] | null) => {
    if (!nextFiles || locked) return
    onFilesAdded(Array.from(nextFiles))
  }

  const activityLabel = activity?.kind === 'file'
    ? activity.phase === 'requesting'
      ? '正在等待接收方确认文件'
      : activity.phase === 'transferring'
        ? '正在传输文件'
        : activity.phase === 'complete'
          ? '文件传输完成'
          : '文件传输结束，但有接收方未完成'
    : activity?.phase === 'complete'
      ? '文本传输完成'
      : activity?.phase === 'error'
        ? '文本传输结束，但有接收方未完成'
        : '正在传输文本'

  return (
    <section
      className="native-scrollbar flex max-h-[calc(100svh-2rem)] w-[calc(100vw-2rem)] max-w-xl flex-col gap-5 overflow-y-auto py-0.5 sm:gap-6"
      aria-label="发送内容"
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div
          className="flex w-full rounded-xl bg-white/5 p-1 sm:w-auto"
          role="tablist"
          aria-label="传输类型"
        >
          <button
            ref={textTabRef}
            id={`${tabId}-text-tab`}
            type="button"
            role="tab"
            aria-selected={tab === 'text'}
            aria-controls={`${tabId}-text-panel`}
            tabIndex={tab === 'text' ? 0 : -1}
            disabled={locked}
            className={`min-h-11 flex-1 rounded-lg border border-transparent px-4 text-sm transition-colors focus-visible:border-accent focus-visible:outline-none disabled:cursor-not-allowed sm:flex-none ${
              tab === 'text'
                ? 'bg-white/10 text-amber-50/80'
                : 'text-amber-50/60 hover:text-amber-50/80'
            }`}
            onClick={() => selectTab('text')}
            onKeyDown={handleTabKeyDown}
          >
            传输文本
          </button>
          <button
            ref={fileTabRef}
            id={`${tabId}-file-tab`}
            type="button"
            role="tab"
            aria-selected={tab === 'file'}
            aria-controls={`${tabId}-file-panel`}
            tabIndex={tab === 'file' ? 0 : -1}
            disabled={locked}
            className={`min-h-11 flex-1 rounded-lg border border-transparent px-4 text-sm transition-colors focus-visible:border-accent focus-visible:outline-none disabled:cursor-not-allowed sm:flex-none ${
              tab === 'file'
                ? 'bg-white/10 text-amber-50/80'
                : 'text-amber-50/60 hover:text-amber-50/80'
            }`}
            onClick={() => selectTab('file')}
            onKeyDown={handleTabKeyDown}
          >
            传输文件
          </button>
        </div>

        <div className="flex items-center justify-between gap-3 sm:justify-end">
          <div className="min-w-0 text-left sm:text-right">
            <div className="text-xs text-amber-50/50 tabular-nums">房间 {room.code}</div>
            <div className="mt-0.5 text-xs text-amber-50/60">
              {connectedCount > 0
                ? `${String(connectedCount)} 位接收者已连接`
                : '等待接收者连接'}
            </div>
          </div>
          {!activity && (
            <Avatar seed={visitor.avatarSeed} label={visitor.displayName} className="shrink-0" />
          )}
        </div>
      </div>

      {activity && (
        <div className="flex justify-center rounded-xl border border-amber-50/10 bg-white/[0.025] px-4 py-4">
          <TransferPeerFlow
            sender={visitor}
            receivers={receivers}
            phase={activity.phase}
            accessibleLabel={activityLabel}
          />
        </div>
      )}

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

      {tab === 'text' && (
        <div id={`${tabId}-text-panel`} role="tabpanel" aria-labelledby={`${tabId}-text-tab`}>
          <div className="relative h-52 sm:h-56" style={{ fontSize: 0 }}>
            <textarea
              placeholder="输入要传输的文本…"
              maxLength={MAX_TEXT_CHARACTERS}
              value={text}
              disabled={locked}
              onChange={event => {
                setText(event.target.value)
                if (sendError) setSendError('')
              }}
              className="native-scrollbar h-full w-full resize-none rounded-xl border border-amber-50/15 bg-transparent p-4 pb-9 text-sm text-amber-50/80 outline-none transition-colors placeholder:text-amber-50/50 focus-visible:border-accent disabled:cursor-not-allowed disabled:opacity-60"
              aria-label="要传输的文本"
            />
            <span className="pointer-events-none absolute bottom-4 right-4 text-xs text-amber-50/60 tabular-nums">
              {text.length}/{String(MAX_TEXT_CHARACTERS)}
            </span>
          </div>
        </div>
      )}

      {tab === 'file' && (
        <div id={`${tabId}-file-panel`} role="tabpanel" aria-labelledby={`${tabId}-file-tab`}>
          <div
            role="button"
            tabIndex={locked ? -1 : 0}
            aria-label="选择要传输的文件"
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
          >
            {files.length === 0 ? (
              <div className="flex flex-1 flex-col items-center justify-center px-5 text-center">
                <span className="material-symbols-outlined text-amber-50/30" style={{ fontSize: '28px' }} aria-hidden="true">upload_file</span>
                <div className="mt-3 text-sm text-amber-50/70">拖拽文件到这里，或点击选择</div>
                <p className="mt-2 text-xs leading-5 text-amber-50/50">一次最多 10 个文件，总计不超过 100 MiB</p>
              </div>
            ) : (
              <div className="flex flex-1 flex-col gap-2" onClick={event => event.stopPropagation()}>
                {files.map(selection => {
                  const presentation = activity?.files[selection.fileId]
                  const progress = presentation
                    ? presentation.state === 'error'
                      ? terminalErrorProgress(activity, selection.fileId)
                      : aggregateFileProgress(activity, selection.fileId)
                    : 0
                  const state = presentation?.state ?? 'queued'
                  return (
                    <FileTransferRow
                      key={selection.fileId}
                      fileId={selection.fileId}
                      name={selection.file.name}
                      byteLength={selection.file.size}
                      progress={progress}
                      state={state}
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
                    添加更多文件
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
        </div>
      )}

      {activity ? (
        <button
          type="button"
          className="flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-amber-50/15 bg-transparent px-4 text-sm text-amber-50/60 transition-colors hover:bg-white/5 hover:text-amber-50/80 focus-visible:border-accent focus-visible:outline-none disabled:cursor-not-allowed disabled:text-amber-50/30"
          onClick={onCancel}
          disabled={activity.phase === 'complete' || activity.phase === 'error'}
        >
          {activity.phase === 'complete' || activity.phase === 'error' ? activityLabel : '取消传输'}
        </button>
      ) : (
        <button
          type="button"
          className={`flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-transparent px-4 text-sm transition-[filter,color,background-color,border-color] focus-visible:border-amber-50/80 focus-visible:outline-none ${
            (tab === 'text' ? canSendText : canSendFiles)
              ? 'cursor-pointer bg-accent text-white/90 hover:brightness-110 active:brightness-90'
              : 'cursor-not-allowed bg-white/5 text-amber-50/30'
          }`}
          disabled={tab === 'text' ? !canSendText : !canSendFiles}
          onClick={() => {
            if (tab === 'text') void handleTextSend()
            else void handleFileSend()
          }}
        >
          {submitting && (
            <span className="material-symbols-outlined motion-safe:animate-spin" style={{ fontSize: '16px' }} aria-hidden="true">progress_activity</span>
          )}
          {tab === 'file'
            ? files.length > 0
              ? `发送 ${String(files.length)} 个文件`
              : '选择文件'
            : connectedCount === 0
              ? '等待接收者连接'
              : connectedCount === 1
                ? '发送给 1 位接收者'
                : `发送给 ${String(connectedCount)} 位接收者`}
        </button>
      )}
    </section>
  )
}
