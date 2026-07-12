import { useMemo, useRef, useState } from 'react'

type RoomJoinProps = {
  busy?: boolean
  onCreateRoom(): void
  onJoinRoom(code: string): void
}

export default function RoomJoin({
  busy = false,
  onCreateRoom,
  onJoinRoom,
}: RoomJoinProps) {
  const [digits, setDigits] = useState(Array.from({ length: 6 }, () => ''))
  const inputRefs = useRef<(HTMLInputElement | null)[]>([])
  const code = useMemo(() => digits.join(''), [digits])

  const handleInput = (index: number, e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value.replace(/\D/g, '').slice(-1)

    setDigits(prev => {
      const next = [...prev]
      next[index] = value
      return next
    })

    if (value && index < 5) {
      inputRefs.current[index + 1]?.focus()
    }
  }

  const handleKeyDown = (index: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace' && !digits[index] && index > 0) {
      inputRefs.current[index - 1]?.focus()
    }
  }

  const handlePaste = (e: React.ClipboardEvent) => {
    e.preventDefault()
    const text = e.clipboardData.getData('text')
    const chars = text.replace(/\D/g, '').split('').slice(0, 6)
    setDigits(prev => {
      const next = [...prev]
      chars.forEach((char, i) => {
        next[i] = char
      })
      return next
    })
    const nextIndex = Math.min(chars.length, 5)
    inputRefs.current[nextIndex]?.focus()
  }

  return (
    <div className="flex w-full max-w-sm flex-col items-center">
      {/* 验证码输入 */}
      <fieldset
        className="mb-8 grid w-full grid-cols-6 gap-2 sm:gap-3"
        onPaste={handlePaste}
      >
        <legend className="sr-only">输入 6 位房间码</legend>
        {Array.from({ length: 6 }).map((_, i) => (
          <input
            key={i}
            ref={el => { inputRefs.current[i] = el }}
            type="text"
            maxLength={1}
            inputMode="numeric"
            aria-label={`房间码第 ${i + 1} 位`}
            value={digits[i]}
            className="h-14 min-w-0 w-full rounded-lg border border-amber-50/15 bg-transparent text-center font-mono text-xl text-amber-50 outline-none transition-colors focus:border-accent"
            onChange={e => handleInput(i, e)}
            onKeyDown={e => handleKeyDown(i, e)}
          />
        ))}
      </fieldset>
      {/* 加入房间 */}
      <button
        className={`w-full py-3 px-16 rounded-xl text-sm transition-all ${
          busy || code.length !== 6
            ? 'bg-white/5 text-amber-50/20 cursor-not-allowed'
            : 'bg-accent text-white/90 hover:brightness-110 active:brightness-90 cursor-pointer'
        }`}
        disabled={busy || code.length !== 6}
        onClick={() => onJoinRoom(code)}
      >
        {busy ? '连接中…' : '加入房间'}
      </button>
      {/* 分割线 */}
      <div className="w-full flex items-center gap-3 my-5">
        <div className="flex-1 h-px bg-amber-50/10" />
        <span className="text-xs text-amber-50/50">OR</span>
        <div className="flex-1 h-px bg-amber-50/10" />
      </div>
      {/* 创建房间 */}
      <button
        className={`w-full py-3 px-16 rounded-xl border border-amber-50/15 text-sm transition-all ${
          busy
            ? 'text-amber-50/20 cursor-not-allowed'
            : 'text-amber-50/50 hover:bg-amber-50/5 hover:text-amber-50/70 active:bg-amber-50/10 cursor-pointer'
        }`}
        disabled={busy}
        onClick={onCreateRoom}
      >
        创建房间
      </button>

      {/* 隐私声明 */}
      <div className="mt-6 text-center text-xs leading-5 text-amber-50/40">
        数据通过端到端加密直接在设备间传输，不会存储在任何服务器上。
        <br />
        文件传输结束即从内存清除，不留缓存。
      </div>
    </div>
  )
}
