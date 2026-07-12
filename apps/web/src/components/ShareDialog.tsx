import { useEffect, useId, useRef, useState } from 'react'
import QRCode from 'qrcode'

export type ShareDialogProps = {
  roomCode: string
  roomUrl?: string
  onCopy(code: string): void
  onClose(): void
}

export default function ShareDialog({
  roomCode,
  roomUrl,
  onCopy,
  onClose,
}: ShareDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const closingRef = useRef(false)
  const titleId = useId()

  const [qrStatus, setQrStatus] = useState<'generating' | 'ready' | 'error'>('generating')
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied'>('idle')

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return

    closingRef.current = false
    if (!dialog.open) dialog.showModal()
    closeButtonRef.current?.focus()

    // Generate QR code
    const canvas = canvasRef.current
    if (!canvas) return

    const qrUrl = roomUrl ?? roomCode
    setQrStatus('generating')
    QRCode.toCanvas(canvas, qrUrl, {
      width: 180,
      margin: 2,
      color: {
        dark: '#e8ded0',
        light: '#2d2d2d00',
      },
    })
      .then(() => setQrStatus('ready'))
      .catch(() => setQrStatus('error'))

    return () => {
      if (dialog.open) dialog.close()
    }
  }, [roomCode, roomUrl])

  const closeOnce = () => {
    if (closingRef.current) return
    closingRef.current = true
    dialogRef.current?.close()
    onClose()
  }

  const handleCopyCode = () => {
    onCopy(roomCode)
    setCopyStatus('copied')
  }

  const handleShareUrl = async () => {
    if (roomUrl && navigator.share) {
      try {
        await navigator.share({
          title: 'P2P Transmission 房间',
          text: `加入我的 P2P 传输房间：${roomCode}`,
          url: roomUrl,
        })
        return
      } catch {
        // User cancelled or share unavailable
      }
    }
    // Fallback: copy room URL
    if (roomUrl) {
      onCopy(roomUrl)
    } else {
      onCopy(roomCode)
    }
    setCopyStatus('copied')
  }

  return (
    <dialog
      ref={dialogRef}
      className="incoming-transfer-dialog m-auto max-h-[calc(100svh-2rem)] w-[calc(100%-2rem)] max-w-sm overflow-y-auto rounded-xl border border-amber-50/15 bg-surface-elevated p-0 text-amber-50/80 backdrop:bg-black/60"
      aria-modal="true"
      aria-labelledby={titleId}
      onCancel={event => {
        event.preventDefault()
        closeOnce()
      }}
    >
      <div className="p-5 sm:p-6">
        <h2 id={titleId} className="text-sm font-normal text-amber-50/80">
          分享房间
        </h2>
        <p className="mt-1 text-xs text-amber-50/50">
          让对方扫描二维码或输入房间码加入
        </p>

        <div className="mt-5 flex flex-col items-center gap-4">
          {/* QR Code */}
          <div className="flex size-49 items-center justify-center rounded-xl bg-surface">
            {qrStatus === 'generating' && (
              <span className="text-xs text-amber-50/50">生成二维码中…</span>
            )}
            {qrStatus === 'error' && (
              <span className="text-xs text-amber-50/50">生成失败</span>
            )}
            <canvas
              ref={canvasRef}
              className={qrStatus === 'ready' ? 'block' : 'hidden'}
              aria-label={`房间 ${roomCode} 的二维码`}
              role="img"
            />
          </div>

          {/* Room code */}
          <div className="flex items-center gap-2">
            <span className="font-mono text-xl tracking-[0.15em] text-amber-50/80">
              {roomCode}
            </span>
            <button
              type="button"
              className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-transparent text-amber-50/50 transition-colors hover:bg-white/5 hover:text-amber-50/80 focus-visible:border-accent focus-visible:outline-none"
              onClick={handleCopyCode}
              aria-label={copyStatus === 'copied' ? '已复制' : '复制房间码'}
            >
              <span className="material-symbols-outlined" style={{ fontSize: '17px' }} aria-hidden="true">
                {copyStatus === 'copied' ? 'check' : 'content_copy'}
              </span>
            </button>
          </div>

          {/* Share / copy link */}
          <button
            type="button"
            className="flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-accent bg-accent px-4 text-sm text-white/90 transition-[filter,border-color] hover:brightness-110 active:brightness-90 focus-visible:border-amber-50/80 focus-visible:outline-none"
            onClick={handleShareUrl}
          >
            <span className="material-symbols-outlined" style={{ fontSize: '17px' }} aria-hidden="true">
              {navigator.share ? 'share' : 'link'}
            </span>
            {navigator.share ? '分享房间链接' : '复制房间链接'}
          </button>
        </div>

        <div className="mt-5 flex justify-center">
          <button
            ref={closeButtonRef}
            type="button"
            className="min-h-11 rounded-xl border border-amber-50/15 px-6 text-sm text-amber-50/60 transition-colors hover:bg-white/5 hover:text-amber-50/80 focus-visible:border-accent focus-visible:outline-none"
            onClick={closeOnce}
          >
            关闭
          </button>
        </div>
      </div>
    </dialog>
  )
}
