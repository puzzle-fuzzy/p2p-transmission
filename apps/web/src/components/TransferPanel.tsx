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
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
      </div>

      {/* 错误提示 */}
      {errorBanner && (
        <div className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-red-500/10 border border-red-500/20">
          <svg className="w-4 h-4 shrink-0 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
          </svg>
          <span className="flex-1 text-red-400 text-xs">{errorBanner}</span>
          <button
            className="text-red-400/50 hover:text-red-400 cursor-pointer"
            onClick={() => setErrorBanner('')}
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" />
            </svg>
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
              <svg className="w-8 h-8 text-amber-50/20" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
              </svg>
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
                      <svg className="w-4 h-4 shrink-0 text-amber-50/30" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                      </svg>
                      <span className="flex-1 text-amber-50/60 text-xs truncate">{file.name}</span>
                      <span className="text-amber-50/20 text-xs shrink-0">{formatSize(file.size)}</span>
                      {fileStates[i] === 'done' ? (
                        <svg className="w-4 h-4 shrink-0 text-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                        </svg>
                      ) : fileStates[i] === 'error' ? (
                        <button
                          className="text-red-400 hover:text-red-300 transition-colors cursor-pointer shrink-0"
                          onClick={() => retryFile(i)}
                          title="重试"
                        >
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182" />
                          </svg>
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
            <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
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
