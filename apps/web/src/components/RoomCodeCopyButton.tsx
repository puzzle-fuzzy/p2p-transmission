import { useEffect, useRef, useState } from 'react'

export type RoomCodeCopyButtonProps = {
  code: string
  onCopy(code: string): Promise<void>
}

type CopyStatus = 'idle' | 'copying' | 'copied' | 'error'

const statusAnnouncement: Record<CopyStatus, string> = {
  idle: '',
  copying: '正在复制房间码',
  copied: '房间码已复制',
  error: '无法复制房间码',
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

  return (
    <>
      <button
        type="button"
        className="group flex min-h-11 shrink-0 cursor-pointer items-center gap-1 rounded-xl text-amber-50/50 transition-colors hover:text-amber-50/80 focus-visible:text-amber-50/80 focus-visible:outline-none disabled:cursor-wait disabled:text-amber-50/20"
        aria-label="复制房间码"
        data-status={status}
        disabled={status === 'copying'}
        onClick={() => { void handleCopy() }}
      >
        <span className="font-mono text-xl tracking-[0.2em] text-amber-50/80 tabular-nums">
          {code}
        </span>
        <span
          className="flex size-11 shrink-0 items-center justify-center rounded-full transition-colors group-hover:bg-white/5 group-focus-visible:bg-white/5 group-disabled:bg-transparent"
        >
          <span
            className="material-symbols-outlined"
            style={{ fontSize: '17px' }}
            aria-hidden="true"
          >
            content_copy
          </span>
        </span>
      </button>
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {statusAnnouncement[status]}
      </span>
    </>
  )
}
