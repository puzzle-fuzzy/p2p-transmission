import { useState } from 'react'
import TransferPanel from './components/TransferPanel'

type LogEntry = { time: string; text: string; type?: 'info' | 'error' }

const logs: LogEntry[] = [
  { time: '14:23:11', text: '正在沟通好友…' },
  { time: '14:23:15', text: '已发送 design.png 文件' },
  { time: '14:23:18', text: '已发送 需求文档.docs 文件' },
  { time: '14:23:22', text: '好友已接收 design.png' },
  { time: '14:23:25', text: '传输超时，photo.jpg 发送失败', type: 'error' },
  { time: '14:23:30', text: '正在等待好友接收 需求文档.docs…' },
]

function App() {
  const [logVisible, setLogVisible] = useState(true)

  return (
    <div className="h-svh bg-[#2d2d2d] flex justify-center items-center">
      <div className="flex gap-8">
        <TransferPanel onToggleLog={() => setLogVisible(v => !v)} />
        <div className="w-px bg-amber-50/10 transition-opacity duration-250 ease-out" style={{ opacity: logVisible ? 1 : 0 }} />
        <div
          className="overflow-hidden transition-[max-width,min-width] duration-250 ease-out"
          style={{
            maxWidth: logVisible ? 320 : 0,
            minWidth: logVisible ? 320 : 0,
          }}
        >
          <div
            className="flex flex-col gap-3 pt-1"
            style={{
              width: 320,
              opacity: logVisible ? 1 : 0,
              transform: logVisible ? 'translateX(0)' : 'translateX(-24px)',
              transition: 'opacity 0.25s ease-out, transform 0.25s ease-out',
              pointerEvents: logVisible ? 'auto' : 'none',
            }}
          >
            <span className="text-amber-50/30 text-xs whitespace-nowrap">传输日志</span>
            <div className="flex flex-col gap-2.5">
              {logs.map((log, i) => (
                <div key={i} className="flex gap-2 text-xs items-baseline">
                  <span className="text-amber-50/15 tabular-nums shrink-0">{log.time}</span>
                  <span className={log.type === 'error' ? 'text-red-400' : 'text-amber-50/50'}>{log.text}</span>
                  {log.type === 'error' && (
                    <svg className="w-3 h-3 shrink-0 text-red-400/60 translate-y-[1.5px]" viewBox="0 0 16 16" fill="none">
                      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" />
                      <path d="M8 5v3.5M8 11h.005" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                    </svg>
                  )}
                  {log.text.endsWith('…') && !log.type && (
                    <svg className="w-3 h-3 shrink-0 text-amber-50/50 translate-y-[1.5px]" viewBox="0 0 16 16" fill="none" style={{ animation: 'spin-slow 1s linear infinite' }}>
                      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" strokeDasharray="30" strokeDashoffset="10" strokeLinecap="round" />
                    </svg>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export default App
