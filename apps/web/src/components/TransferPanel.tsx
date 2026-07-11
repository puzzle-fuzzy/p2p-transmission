import { useRef, useState } from 'react'

type Tab = 'text' | 'file'

const MAX_CHARS = 500

export default function TransferPanel() {
  const [tab, setTab] = useState<Tab>('text')
  const [text, setText] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(e.target.files ?? [])
    setFiles(prev => [...prev, ...selected])
    e.target.value = ''
  }

  const removeFile = (index: number) => {
    setFiles(prev => prev.filter((_, i) => i !== index))
  }

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  const [progress, setProgress] = useState<Record<number, number>>({})

  const startMockTransfer = () => {
    const intervals: ReturnType<typeof setInterval>[] = []
    files.forEach((_, i) => {
      setProgress(prev => ({ ...prev, [i]: 0 }))
      const interval = setInterval(() => {
        setProgress(prev => {
          const current = prev[i] ?? 0
          if (current >= 100) {
            clearInterval(interval)
            return prev
          }
          const increment = Math.random() * 15 + 2
          return { ...prev, [i]: Math.min(current + increment, 100) }
        })
      }, 200 + Math.random() * 300)
      intervals.push(interval)
    })
  }

  return (
    <div className="w-md flex flex-col gap-6">
      {/* Tab 切换 */}
      <div className="flex rounded-xl bg-white/5 p-1">
        <button
          className={`flex-1 py-2.5 text-sm rounded-lg transition-all cursor-pointer ${
            tab === 'text'
              ? 'bg-white/10 text-amber-50/80'
              : 'text-amber-50/40 hover:text-amber-50/60'
          }`}
          onClick={() => setTab('text')}
        >
          传输文本
        </button>
        <button
          className={`flex-1 py-2.5 text-sm rounded-lg transition-all cursor-pointer ${
            tab === 'file'
              ? 'bg-white/10 text-amber-50/80'
              : 'text-amber-50/40 hover:text-amber-50/60'
          }`}
          onClick={() => setTab('file')}
        >
          传输文件
        </button>
      </div>

      {/* 文本输入框 */}
      {tab === 'text' && (
        <div className="relative">
          <textarea
            placeholder="输入要传输的文本…"
            maxLength={MAX_CHARS}
            value={text}
            onChange={e => setText(e.target.value)}
            className="w-full h-56 bg-transparent border border-amber-50/15 rounded-xl p-4 pb-8 text-amber-50/80 text-sm outline-none resize-none focus:border-accent transition-colors placeholder:text-amber-50/20"
          />
          <span className="absolute bottom-4 right-4 text-amber-50/20 text-xs tabular-nums">
            {text.length}/{MAX_CHARS}
          </span>
        </div>
      )}

      {/* 文件选择区域 */}
      {tab === 'file' && (
        <div
          className={`w-full min-h-56 border-2 border-dashed border-amber-50/15 rounded-xl flex flex-col ${
            files.length === 0 ? 'justify-center items-center gap-2' : 'justify-start'
          } cursor-pointer hover:border-amber-50/30 transition-colors`}
          onClick={() => fileInputRef.current?.click()}
        >
          {files.length === 0 ? (
            <>
              <svg className="w-8 h-8 text-amber-50/20" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
              </svg>
              <span className="text-amber-50/20 text-sm">拖拽文件到此处或点击选择</span>
            </>
          ) : (
            <div className="w-full p-3 flex flex-col gap-2" onClick={e => e.stopPropagation()}>
              {files.map((file, i) => (
                <div key={i} className="relative overflow-hidden bg-white/5 rounded-lg">
                  {/* 背景进度条 */}
                  <div
                    className="absolute inset-0 transition-all duration-300 rounded-lg"
                    style={{
                      width: `${progress[i] ?? 0}%`,
                      backgroundColor: '#5e11d1',
                      opacity: 0.15,
                    }}
                  />
                  {/* 内容 */}
                  <div className="relative flex items-center gap-3 px-3 py-2 z-10">
                    <svg className="w-4 h-4 shrink-0 text-amber-50/30" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                    </svg>
                    <span className="flex-1 text-amber-50/60 text-xs truncate">{file.name}</span>
                    <span className="text-amber-50/20 text-xs shrink-0">{formatSize(file.size)}</span>
                    {progress[i] === 100 ? (
                      <svg className="w-4 h-4 shrink-0 text-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                    ) : (
                      <button
                        className="text-amber-50/20 hover:text-amber-50/50 transition-colors cursor-pointer shrink-0"
                        onClick={() => removeFile(i)}
                      >
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    )}
                  </div>
                </div>
              ))}
              <div
                className="flex items-center justify-center gap-1.5 mt-1 text-amber-50/20 hover:text-amber-50/40 transition-colors cursor-pointer"
                onClick={() => fileInputRef.current?.click()}
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 4v16m8-8H4" />
                </svg>
                <span className="text-xs">添加更多文件</span>
              </div>
            </div>
          )}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={handleFileChange}
          />
        </div>
      )}

      {/* 传输按钮 */}
      <button
        className="w-full cursor-pointer py-3 rounded-xl bg-accent text-white/90 text-sm tracking-wider hover:brightness-110 active:brightness-90 transition-all"
        onClick={startMockTransfer}
      >
        传输
      </button>
    </div>
  )
}
