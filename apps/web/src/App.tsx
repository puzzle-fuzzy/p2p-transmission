import TransferPanel from './components/TransferPanel'

const logs = [
  { time: '14:23:11', text: '正在沟通好友…' },
  { time: '14:23:15', text: '已发送 design.png 文件' },
  { time: '14:23:18', text: '已发送 需求文档.docs 文件' },
  { time: '14:23:22', text: '好友已接收 design.png' },
  { time: '14:23:30', text: '正在等待好友接收 需求文档.docs…' },
]

function App() {
  return (
    <div className="h-svh bg-[#2d2d2d] flex justify-center items-center">
      <div className="flex gap-8">
        <TransferPanel />
        <div className="w-px bg-amber-50/10" />
        <div className="flex flex-col gap-3 pt-1 min-w-60">
          <span className="text-amber-50/30 text-xs tracking-wider">传输日志</span>
          <div className="flex flex-col gap-2.5">
            {logs.map((log, i) => (
              <div key={i} className="flex gap-2 text-xs items-baseline">
                <span className="text-amber-50/15 tabular-nums shrink-0">{log.time}</span>
                <span className="text-amber-50/50">{log.text}</span>
                {log.text.endsWith('…') && (
                  <svg className="w-3 h-3 shrink-0 text-amber-50/50" viewBox="0 0 16 16" fill="none" style={{ animation: 'spin-slow 1s linear infinite' }}>
                    <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" strokeDasharray="30" strokeDashoffset="10" strokeLinecap="round" />
                  </svg>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

export default App
