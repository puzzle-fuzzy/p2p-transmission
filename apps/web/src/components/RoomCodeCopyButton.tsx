import { useEffect, useRef, useState } from 'react'

export type RoomCodeCopyButtonProps = {
  code: string
  onCopy(code: string): Promise<void>
}

type CopyStatus = 'idle' | 'copying' | 'copied' | 'error'

const statusContent: Record<CopyStatus, { icon: string; announcement: string }> = {
  idle: { icon: 'content_copy', announcement: '' },
  copying: { icon: 'progress_activity', announcement: '正在复制房间码' },
  copied: { icon: 'check', announcement: '房间码已复制' },
  error: { icon: 'error', announcement: '无法复制房间码' },
}

export default function RoomCodeCopyButton({ code, onCopy }: RoomCodeCopyButtonProps) {
  const [status, setStatus] = useState<CopyStatus>('idle')
  const operationRef = useRef(0)

  useEffect(() => {
    operationRef.current += 1
    setStatus('idle')
  }, [code])

  useEffect(() => () => {
    operationRef.current += 1
  }, [])

  const handleCopy = async () => {
    if (status === 'copying') return

    const operation = operationRef.current + 1
    operationRef.current = operation
    setStatus('copying')

    try {
      await onCopy(code)
      if (operationRef.current === operation) setStatus('copied')
    } catch {
      if (operationRef.current === operation) setStatus('error')
    }
  }

  const content = statusContent[status]

  return (
    <>
      <button
        type="button"
        className="flex min-h-11 min-w-11 shrink-0 cursor-pointer items-center justify-center rounded-lg border border-amber-50/15 text-amber-50/50 transition-colors hover:bg-white/5 hover:text-amber-50/80 focus-visible:border-accent focus-visible:text-amber-50/80 focus-visible:outline-none disabled:cursor-wait disabled:text-amber-50/20"
        aria-label="复制房间码"
        data-status={status}
        disabled={status === 'copying'}
        onClick={() => { void handleCopy() }}
      >
        <span
          className={`material-symbols-outlined ${status === 'copying' ? 'motion-safe:animate-spin' : ''}`}
          style={{ fontSize: '17px' }}
          aria-hidden="true"
        >
          {content.icon}
        </span>
      </button>
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {content.announcement}
      </span>
    </>
  )
}
