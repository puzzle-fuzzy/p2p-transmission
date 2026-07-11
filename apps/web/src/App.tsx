import TransferPanel from './components/TransferPanel'

function App() {
  return (
    <div className="h-svh bg-[#2d2d2d] flex justify-center items-center">
      <div className="flex gap-8">
        <TransferPanel />
        {/* <div className="w-px bg-amber-50/10 transition-opacity duration-250 ease-out" style={{ opacity: logVisible ? 1 : 0 }} />
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
                <div key={i} className="flex gap-2 text-xs items-end overflow-hidden">
                  <span className="text-amber-50/15 tabular-nums shrink-0">{log.time}</span>
                  <span className={log.type === 'error' ? 'text-red-400' : 'text-amber-50/50'}>{log.text}</span>
                  {log.type === 'error' && (
                    <div className='w-4 h-4 flex justify-center items-center'>
                      <span className="material-symbols-outlined leading-none text-red-400/60" style={{ fontSize: '12px' }}>error</span>
                    </div>
                  )}
                  {log.text.endsWith('…') && !log.type && (
                    <div className='w-4 h-4 flex justify-center items-center'>
                      <span className="material-symbols-outlined leading-none text-amber-50/50 animate-spin" style={{ fontSize: '12px' }}>progress_activity</span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
      </div> */}

      </div>
    </div>
  )
}

export default App
