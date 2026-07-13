import { useEffect, useId, useRef, useState } from 'react'
import QRCode from 'qrcode'

export type ShareDialogProps = {
  roomCode: string
  roomUrl: string
  onCopy(value: string): Promise<void>
  onClose(): void
}

type CodeCopyStatus = 'idle' | 'copying' | 'copied'
type LinkActionStatus = 'idle' | 'sharing' | 'copying' | 'copied' | 'shared'

const isAbortError = (error: unknown) =>
  typeof error === 'object'
  && error !== null
  && 'name' in error
  && error.name === 'AbortError'

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
  const codeCopyPendingRef = useRef(false)
  const linkActionPendingRef = useRef(false)
  const codeCopyOperationRef = useRef(0)
  const linkActionOperationRef = useRef(0)
  const titleId = useId()

  const [qrStatus, setQrStatus] = useState<'generating' | 'ready' | 'error'>('generating')
  const [codeCopyStatus, setCodeCopyStatus] = useState<CodeCopyStatus>('idle')
  const [linkActionStatus, setLinkActionStatus] = useState<LinkActionStatus>('idle')
  const nativeShare = (navigator as {
    share?: (data?: ShareData) => Promise<void>
  }).share
  const hasNativeShare = typeof nativeShare === 'function'

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return

    codeCopyOperationRef.current += 1
    linkActionOperationRef.current += 1
    codeCopyPendingRef.current = false
    linkActionPendingRef.current = false
    setCodeCopyStatus('idle')
    setLinkActionStatus('idle')
    closingRef.current = false
    if (!dialog.open) dialog.showModal()
    closeButtonRef.current?.focus()

    // Generate QR code
    const canvas = canvasRef.current
    if (!canvas) return

    let active = true
    setQrStatus('generating')
    QRCode.toCanvas(canvas, roomUrl, {
      width: 180,
      margin: 2,
      color: {
        dark: '#e8ded0',
        light: '#2d2d2d00',
      },
    })
      .then(() => {
        if (active) setQrStatus('ready')
      })
      .catch(() => {
        if (active) setQrStatus('error')
      })

    return () => {
      active = false
      codeCopyOperationRef.current += 1
      linkActionOperationRef.current += 1
      codeCopyPendingRef.current = false
      linkActionPendingRef.current = false
      if (dialog.open) dialog.close()
    }
  }, [roomCode, roomUrl])

  const closeOnce = () => {
    if (closingRef.current) return
    closingRef.current = true
    dialogRef.current?.close()
    onClose()
  }

  const handleCopyCode = async () => {
    if (codeCopyPendingRef.current) return
    codeCopyPendingRef.current = true
    const operation = ++codeCopyOperationRef.current
    setCodeCopyStatus('copying')

    try {
      await onCopy(roomCode)
      if (codeCopyOperationRef.current === operation) {
        setCodeCopyStatus('copied')
      }
    } catch {
      if (codeCopyOperationRef.current === operation) {
        setCodeCopyStatus('idle')
      }
    } finally {
      if (codeCopyOperationRef.current === operation) {
        codeCopyPendingRef.current = false
      }
    }
  }

  const handleShareUrl = async () => {
    if (linkActionPendingRef.current) return
    linkActionPendingRef.current = true
    const operation = ++linkActionOperationRef.current
    setLinkActionStatus(hasNativeShare ? 'sharing' : 'copying')

    try {
      if (hasNativeShare) {
        try {
          await nativeShare.call(navigator, {
            title: 'P2P Transmission 房间',
            text: `加入我的 P2P 传输房间：${roomCode}`,
            url: roomUrl,
          })
          if (linkActionOperationRef.current === operation) {
            setLinkActionStatus('shared')
          }
          return
        } catch (error) {
          if (isAbortError(error)) {
            if (linkActionOperationRef.current === operation) {
              setLinkActionStatus('idle')
            }
            return
          }
          if (linkActionOperationRef.current === operation) {
            setLinkActionStatus('copying')
          }
        }
      }

      await onCopy(roomUrl)
      if (linkActionOperationRef.current === operation) {
        setLinkActionStatus('copied')
      }
    } catch {
      if (linkActionOperationRef.current === operation) {
        setLinkActionStatus('idle')
      }
    } finally {
      if (linkActionOperationRef.current === operation) {
        linkActionPendingRef.current = false
      }
    }
  }

  const codeCopyLabel = codeCopyStatus === 'copying'
    ? '正在复制房间码'
    : codeCopyStatus === 'copied'
      ? '房间码已复制'
      : '复制房间码'
  const linkActionLabel = linkActionStatus === 'sharing'
    ? '分享中…'
    : linkActionStatus === 'copying'
      ? '复制中…'
      : linkActionStatus === 'shared'
      ? '已分享'
      : linkActionStatus === 'copied'
        ? '链接已复制'
        : hasNativeShare ? '分享房间链接' : '复制房间链接'

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
          扫描二维码或打开房间链接加入；房间码仅用于核对。
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
              className="flex size-11 shrink-0 items-center justify-center rounded-full border border-transparent text-amber-50/50 transition-colors hover:bg-white/5 hover:text-amber-50/80 focus-visible:border-accent focus-visible:outline-none disabled:cursor-wait disabled:text-amber-50/30"
              disabled={codeCopyStatus === 'copying'}
              onClick={() => { void handleCopyCode() }}
              aria-label={codeCopyLabel}
            >
              <span className="material-symbols-outlined" style={{ fontSize: '17px' }} aria-hidden="true">
                {codeCopyStatus === 'copied' ? 'check' : 'content_copy'}
              </span>
            </button>
          </div>

          <p className="w-full text-center text-xs leading-5 text-amber-50/50">
            此链接包含加入权限，请只发送给可信接收者。
          </p>

          {/* Share / copy link */}
          <button
            type="button"
            className="flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-accent bg-accent px-4 text-sm text-white/90 transition-[filter,border-color] hover:brightness-110 active:brightness-90 focus-visible:border-amber-50/80 focus-visible:outline-none disabled:cursor-wait disabled:brightness-75"
            disabled={linkActionStatus === 'sharing' || linkActionStatus === 'copying'}
            onClick={() => { void handleShareUrl() }}
          >
            <span className="material-symbols-outlined" style={{ fontSize: '17px' }} aria-hidden="true">
              {linkActionStatus === 'copied' || linkActionStatus === 'shared'
                ? 'check'
                : hasNativeShare ? 'share' : 'link'}
            </span>
            {linkActionLabel}
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
