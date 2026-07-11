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
    <div className="flex flex-col items-center">
      {/* 验证码输入 */}
      <div className="flex gap-3 mb-8" onPaste={handlePaste}>
        {Array.from({ length: 6 }).map((_, i) => (
          <input
            key={i}
            ref={el => { inputRefs.current[i] = el }}
            type="text"
            maxLength={1}
            inputMode="numeric"
            value={digits[i]}
            className="w-12 h-14 bg-transparent border border-amber-50/15 rounded-lg text-center text-amber-50 text-xl font-mono outline-none focus:border-accent transition-colors"
            onChange={e => handleInput(i, e)}
            onKeyDown={e => handleKeyDown(i, e)}
          />
        ))}
      </div>
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
        <span className="text-amber-50/20 text-xs">OR</span>
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
    </div>
  )
}
