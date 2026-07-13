import { useId, useMemo, useRef, useState } from 'react'

export type RoomJoinProps = {
  busy?: boolean
  initialCode?: string
  mode: 'invite' | 'manual'
  error?: string
  onCreateRoom(): void
  onSubmit(code: string): void
  onCodeEdited(): void
}

const initialDigits = (code?: string) => {
  const value = code ?? ''
  return /^[0-9]{6}$/u.test(value)
    ? Array.from(value)
    : Array.from({ length: 6 }, () => '')
}

export default function RoomJoin({
  busy = false,
  initialCode,
  mode,
  error,
  onCreateRoom,
  onSubmit,
  onCodeEdited,
}: RoomJoinProps) {
  const [digits, setDigits] = useState(() => initialDigits(initialCode))
  const inputRefs = useRef<(HTMLInputElement | null)[]>([])
  const errorId = useId()
  const code = useMemo(() => digits.join(''), [digits])
  const submitLabel = busy
    ? mode === 'invite' ? '连接中…' : '申请中…'
    : mode === 'invite' ? '加入房间' : '请求加入'

  const handleInput = (index: number, event: React.ChangeEvent<HTMLInputElement>) => {
    const value = event.target.value.replace(/\D/g, '').slice(-1)

    onCodeEdited()
    setDigits(previous => {
      const next = [...previous]
      next[index] = value
      return next
    })

    if (value && index < 5) {
      inputRefs.current[index + 1]?.focus()
    }
  }

  const handleKeyDown = (index: number, event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Backspace' && !digits[index] && index > 0) {
      inputRefs.current[index - 1]?.focus()
    }
  }

  const handlePaste = (event: React.ClipboardEvent) => {
    event.preventDefault()
    const text = event.clipboardData.getData('text')
    const chars = text.replace(/\D/g, '').split('').slice(0, 6)

    onCodeEdited()
    setDigits(Array.from({ length: 6 }, (_, index) => chars[index] ?? ''))
    inputRefs.current[Math.min(chars.length, 5)]?.focus()
  }

  return (
    <div className="flex w-full max-w-sm flex-col items-center">
      <h1 className="w-full text-left text-lg font-normal text-amber-50/80">加入房间</h1>
      <p className="mt-1 mb-4 w-full text-left text-xs leading-5 text-amber-50/50">
        输入发送者提供的 6 位房间码，或直接打开邀请链接
      </p>
      {mode === 'invite' && (
        <div className="mb-4 flex min-h-11 w-full items-center gap-3 rounded-lg bg-white/5 px-4 text-xs leading-5 text-amber-50/70">
          <span
            className="material-symbols-outlined shrink-0 text-accent"
            style={{ fontSize: '17px' }}
            aria-hidden="true"
          >
            verified_user
          </span>
          <span>已读取邀请链接，确认后加入房间</span>
        </div>
      )}

      <fieldset
        className="grid w-full grid-cols-6 gap-1 sm:gap-3"
        onPaste={handlePaste}
      >
        <legend className="sr-only">输入 6 位房间码</legend>
        {Array.from({ length: 6 }).map((_, index) => (
          <input
            key={index}
            ref={element => { inputRefs.current[index] = element }}
            type="text"
            maxLength={1}
            inputMode="numeric"
            autoComplete="one-time-code"
            aria-label={`房间码第 ${String(index + 1)} 位`}
            aria-describedby={error ? errorId : undefined}
            aria-invalid={error ? true : undefined}
            value={digits[index]}
            className="h-14 min-w-0 w-full rounded-lg border border-amber-50/15 bg-transparent text-center font-mono text-xl text-amber-50 outline-none transition-colors focus:border-accent aria-invalid:border-amber-50/50"
            onChange={event => handleInput(index, event)}
            onKeyDown={event => handleKeyDown(index, event)}
          />
        ))}
      </fieldset>

      <div className="min-h-8 w-full pt-2">
        {error && (
          <p id={errorId} role="alert" className="text-xs leading-5 text-amber-50/70">
            {error}
          </p>
        )}
      </div>

      <button
        type="button"
        className={`min-h-11 w-full rounded-xl px-16 text-sm tracking-wider transition-[filter,color,background-color] ${
          busy || code.length !== 6
            ? 'cursor-not-allowed bg-white/5 text-amber-50/20'
            : 'cursor-pointer bg-accent text-white/90 hover:brightness-110 active:brightness-90'
        }`}
        disabled={busy || code.length !== 6}
        onClick={() => onSubmit(code)}
      >
        {submitLabel}
      </button>

      <div className="my-5 flex w-full items-center gap-3" aria-hidden="true">
        <div className="h-px flex-1 bg-amber-50/10" />
        <span className="text-xs text-amber-50/50">OR</span>
        <div className="h-px flex-1 bg-amber-50/10" />
      </div>

      <button
        type="button"
        className={`min-h-11 w-full rounded-xl border border-amber-50/15 px-16 text-sm tracking-wider transition-colors ${
          busy
            ? 'cursor-not-allowed text-amber-50/20'
            : 'cursor-pointer text-amber-50/50 hover:bg-amber-50/5 hover:text-amber-50/70 active:bg-amber-50/10'
        }`}
        disabled={busy}
        onClick={onCreateRoom}
      >
        创建房间
      </button>

      <div className="mt-6 text-center text-xs leading-5 text-amber-50/60">
        {'文件和文本正文通过加密的 WebRTC 通道传输，优先尝试设备直连，必要时经加密中继转发；应用服务器只协调连接，不保存传输内容。接收完成的文件会暂存在当前页面中，关闭结果或退出房间后释放。'}
      </div>
    </div>
  )
}
