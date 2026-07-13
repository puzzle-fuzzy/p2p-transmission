import { useEffect, useId, useRef } from 'react'

export type AboutDialogProps = {
  version: string
  onClose(): void
}

export default function AboutDialog({ version, onClose }: AboutDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const closingRef = useRef(false)
  const titleId = useId()

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return

    closingRef.current = false
    if (!dialog.open) dialog.showModal()
    closeButtonRef.current?.focus()

    return () => {
      if (dialog.open) dialog.close()
    }
  }, [])

  const closeOnce = () => {
    if (closingRef.current) return
    closingRef.current = true
    dialogRef.current?.close()
    onClose()
  }

  return (
    <dialog
      ref={dialogRef}
      className="incoming-transfer-dialog m-auto max-h-[calc(100svh-2rem)] w-[calc(100%-2rem)] max-w-lg overflow-y-auto rounded-xl border border-amber-50/15 bg-surface-elevated p-0 text-amber-50/80 backdrop:bg-black/60"
      aria-modal="true"
      aria-labelledby={titleId}
      onCancel={event => {
        event.preventDefault()
        closeOnce()
      }}
    >
      <div className="p-5 sm:p-6">
        <header>
          <h2 id={titleId} className="text-sm font-normal text-amber-50/80">
            关于 P2P Transmission
          </h2>
          <p className="mt-2 text-base leading-6 text-amber-50/90">
            不注册，不上传，直接把内容传给对方。
          </p>
        </header>

        <div className="mt-5 space-y-5 text-sm leading-6 text-amber-50/65">
          <section>
            <h3 className="text-sm font-medium text-amber-50/85">它是怎么工作的</h3>
            <ol className="mt-2 list-decimal space-y-1 pl-5">
              <li>创建一个临时房间，分享房间码或邀请链接。</li>
              <li>对方确认加入；只输入房间码时，需要房主批准加入申请。</li>
              <li>浏览器优先建立点对点连接，必要时通过 TURN 中继加密的 WebRTC 流量。</li>
            </ol>
          </section>

          <section>
            <h3 className="text-sm font-medium text-amber-50/85">隐私与安全</h3>
            <p className="mt-2">
              文本和文件通过浏览器 WebRTC DataChannel 在双方之间传输。API 只负责临时访客、房间、加入授权、WebSocket 信令和短期 TURN 凭据；它不保存或中继应用载荷。
            </p>
            <p className="mt-2">
              coturn 只在需要时中继加密的 WebRTC 流量，不能读取文本正文或文件内容。邀请链接包含加入权限，请只发送给可信接收者；6 位房间码只是公开标识，不是成员授权凭证。
            </p>
          </section>

          <section>
            <h3 className="text-sm font-medium text-amber-50/85">使用前知道</h3>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              <li>房间默认有效 30 分钟，过期后需要重新创建房间。</li>
              <li>单个文件批次最多 10 个文件，总大小最多 100 MiB。</li>
              <li>网络限制可能让连接需要 TURN 中继；重要文件请保留原始备份。</li>
            </ul>
          </section>

          <section>
            <h3 className="text-sm font-medium text-amber-50/85">构建信息</h3>
            <dl className="mt-2 space-y-1">
              <div className="flex flex-wrap gap-x-2">
                <dt className="text-amber-50/45">生产地址</dt>
                <dd>
                  <a
                    className="text-amber-50/80 underline decoration-amber-50/30 underline-offset-2 hover:text-amber-50 focus-visible:outline-accent"
                    href="https://p2p.yxswy.com"
                    target="_blank"
                    rel="noreferrer"
                  >
                    https://p2p.yxswy.com
                  </a>
                </dd>
              </div>
              <div className="flex flex-wrap gap-x-2">
                <dt className="text-amber-50/45">构建版本</dt>
                <dd>{version}</dd>
              </div>
            </dl>
          </section>
        </div>

        <div className="mt-6 flex justify-center">
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
