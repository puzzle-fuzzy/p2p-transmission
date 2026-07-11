import { useRef } from 'react'

export default function RoomJoin() {
  const inputRefs = useRef<(HTMLInputElement | null)[]>([])

  const handleInput = (index: number, e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.value && index < 5) {
      inputRefs.current[index + 1]?.focus()
    }
  }

  const handleKeyDown = (index: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace' && !e.currentTarget.value && index > 0) {
      inputRefs.current[index - 1]?.focus()
    }
  }

  const handlePaste = (e: React.ClipboardEvent) => {
    e.preventDefault()
    const text = e.clipboardData.getData('text')
    const chars = text.replace(/\D/g, '').split('').slice(0, 6)
    chars.forEach((char, i) => {
      const input = inputRefs.current[i]
      if (input) {
        input.value = char
      }
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
            className="w-12 h-14 bg-transparent border border-amber-50/15 rounded-lg text-center text-amber-50 text-xl font-mono outline-none focus:border-accent transition-colors"
            onChange={e => handleInput(i, e)}
            onKeyDown={e => handleKeyDown(i, e)}
          />
        ))}
      </div>
      {/* 加入房间 */}
      <button className="w-full cursor-pointer py-3 px-16 rounded-xl bg-accent text-white/90 text-sm hover:brightness-110 active:brightness-90 transition-all">
        加入房间
      </button>
      {/* 分割线 */}
      <div className="w-full flex items-center gap-3 my-5">
        <div className="flex-1 h-px bg-amber-50/10" />
        <span className="text-amber-50/20 text-xs">OR</span>
        <div className="flex-1 h-px bg-amber-50/10" />
      </div>
      {/* 创建房间 */}
      <button className="w-full cursor-pointer py-3 px-16 rounded-xl border border-amber-50/15 text-amber-50/50 text-sm hover:bg-amber-50/5 hover:text-amber-50/70 active:bg-amber-50/10 transition-all">
        创建房间
      </button>
    </div>
  )
}
