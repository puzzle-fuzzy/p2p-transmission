import { useCallback, useEffect, useRef, useState } from 'react'

type Tab = 'text' | 'file'

const MAX_CHARS = 500

type FileState = 'pending' | 'transferring' | 'done' | 'error'

export default function TransferPanel({ onToggleLog }: { onToggleLog?: () => void }) {
  const [tab, setTab] = useState<Tab>('text')
  const [text, setText] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)
  const intervalRefs = useRef<ReturnType<typeof setInterval>[]>([])

  const [progress, setProgress] = useState<Record<number, number>>({})
  const [fileStates, setFileStates] = useState<Record<number, FileState>>({})
  const [transferring, setTransferring] = useState(false)
  const [errorBanner, setErrorBanner] = useState('')

  // Cleanup intervals on unmount
  useEffect(() => {
    return () => {
      intervalRefs.current.forEach(clearInterval)
    }
  }, [])

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(e.target.files ?? [])
    setFiles(prev => [...prev, ...selected])
    e.target.value = ''
  }

  const removeFile = useCallback((index: number) => {
    setFiles(prev => prev.filter((_, i) => i !== index))
    setProgress(prev => {
      const next = { ...prev }
      delete next[index]
      return next
    })
    setFileStates(prev => {
      const next = { ...prev }
      delete next[index]
      return next
    })
  }, [])

  const retryFile = useCallback((index: number) => {
    setFileStates(prev => ({ ...prev, [index]: 'transferring' }))
    setProgress(prev => ({ ...prev, [index]: 0 }))
    mockTransferFile(index)
  }, [])

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  const mockTransferFile = (index: number) => {
    const interval = setInterval(() => {
      setProgress(prev => {
        const current = prev[index] ?? 0
        if (current >= 100) {
          clearInterval(interval)
          setFileStates(prev => ({ ...prev, [index]: 'done' }))
          return prev
        }
        const increment = Math.random() * 15 + 2
        const next = Math.min(current + increment, 100)
        // 模拟 10% 概率出错
        if (next > 30 && next < 50 && Math.random() < 0.04) {
          clearInterval(interval)
          setFileStates(prev => ({ ...prev, [index]: 'error' }))
          setErrorBanner(`文件传输失败，请重试`)
          setTransferring(false)
          return prev
        }
        return { ...prev, [index]: next }
      })
    }, 200 + Math.random() * 300)
    intervalRefs.current.push(interval)
  }

  const startMockTransfer = () => {
    if (tab === 'text' && !text.trim()) return
    if (tab === 'file' && files.length === 0) return

    setErrorBanner('')
    setTransferring(true)

    if (tab === 'text') {
      // Mock 文本传输——在日志中可以看到效果
      setTransferring(false)
      return
    }

    files.forEach((_, i) => {
      setFileStates(prev => ({ ...prev, [i]: 'transferring' }))
      setProgress(prev => ({ ...prev, [i]: 0 }))
      mockTransferFile(i)
    })
  }

  const isTransferDisabled =
    (tab === 'text' && !text.trim()) || (tab === 'file' && files.length === 0)

  return (
    <div className="w-md flex flex-col gap-6">
      {/* Tab 切换 */}
      <div className="flex items-center gap-2">
        <div className="flex rounded-xl bg-white/5 p-1">
          <button
            className={`py-2 px-4 text-sm rounded-lg transition-all cursor-pointer ${
              tab === 'text'
                ? 'bg-white/10 text-amber-50/80'
                : 'text-amber-50/40 hover:text-amber-50/60'
            }`}
            onClick={() => setTab('text')}
          >
            传输文本
          </button>
          <button
            className={`py-2 px-4 text-sm rounded-lg transition-all cursor-pointer ${
              tab === 'file'
                ? 'bg-white/10 text-amber-50/80'
                : 'text-amber-50/40 hover:text-amber-50/60'
            }`}
            onClick={() => setTab('file')}
          >
            传输文件
          </button>
        </div>
        <button
          className="ml-auto p-2 text-amber-50/20 hover:text-amber-50/40 transition-colors cursor-pointer"
          onClick={onToggleLog}
          title="切换日志面板"
        >
          <span className="material-symbols-outlined text-base leading-none">list</span>
        </button>
      </div>

      {/* 错误提示 */}
      {errorBanner && (
        <div className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-red-500/10 border border-red-500/20">
          <span className="material-symbols-outlined text-base leading-none text-red-400">warning</span>
          <span className="flex-1 text-red-400 text-xs">{errorBanner}</span>
          <button
            className="text-red-400/50 hover:text-red-400 cursor-pointer"
            onClick={() => setErrorBanner('')}
          >
            <span className="material-symbols-outlined text-sm leading-none">close</span>
          </button>
        </div>
      )}

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
          onKeyDown={e => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              fileInputRef.current?.click()
            }
          }}
          tabIndex={0}
          role="button"
          aria-label="选择文件"
        >
          {files.length === 0 ? (
            <>
              <span className="material-symbols-outlined text-[32px] leading-none text-amber-50/20">upload_file</span>
              <span className="text-amber-50/20 text-sm">拖拽文件到此处或点击选择</span>
              <span className="text-amber-50/10 text-xs">支持所有文件类型</span>
            </>
          ) : (
            <div className="w-full p-3 flex flex-col gap-2" onClick={e => e.stopPropagation()}>
              <div className="flex flex-col gap-2 max-h-60 overflow-y-auto">
                {files.map((file, i) => (
                  <div key={i} className="relative overflow-hidden bg-white/5 rounded-lg">
                    {/* 背景进度条 */}
                    <div
                      className="absolute inset-0 transition-all duration-300 rounded-lg"
                      style={{
                        width: `${progress[i] ?? 0}%`,
                        backgroundColor: fileStates[i] === 'error' ? '#ef4444' : '#5e11d1',
                        opacity: 0.15,
                      }}
                    />
                    {/* 内容 */}
                    <div className="relative flex items-center gap-3 px-3 py-2 z-10">
                      <span className="material-symbols-outlined text-base leading-none text-amber-50/30">description</span>
                      <span className="flex-1 text-amber-50/60 text-xs truncate">{file.name}</span>
                      <span className="text-amber-50/20 text-xs shrink-0">{formatSize(file.size)}</span>
                      {fileStates[i] === 'done' ? (
                        <span className="material-symbols-outlined text-base leading-none text-accent">check_circle</span>
                      ) : fileStates[i] === 'error' ? (
                        <button
                          className="text-red-400 hover:text-red-300 transition-colors cursor-pointer shrink-0"
                          onClick={() => retryFile(i)}
                          title="重试"
                        >
                          <span className="material-symbols-outlined text-base leading-none">refresh</span>
                        </button>
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
              </div>
              <div
                className="flex items-center justify-center gap-1.5 mt-1 text-amber-50/20 hover:text-amber-50/40 transition-colors cursor-pointer"
                onClick={() => fileInputRef.current?.click()}
              >
                <span className="material-symbols-outlined text-sm leading-none">add</span>
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
        className={`w-full cursor-pointer py-3 rounded-xl text-sm transition-all flex items-center justify-center gap-2 ${
          isTransferDisabled || transferring
            ? 'bg-white/5 text-amber-50/20 cursor-not-allowed'
            : 'bg-accent text-white/90 hover:brightness-110 active:brightness-90'
        }`}
        onClick={startMockTransfer}
        disabled={isTransferDisabled || transferring}
      >
        {transferring ? (
          <>
            <span className="material-symbols-outlined text-base leading-none animate-spin">progress_activity</span>
            传输中…
          </>
        ) : tab === 'file' && files.length > 0 ? (
          `传输 ${files.length} 个文件`
        ) : (
          '传输'
        )}
      </button>
    </div>
  )
}
