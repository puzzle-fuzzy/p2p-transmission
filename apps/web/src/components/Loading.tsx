function Loading() {
  return (
    <div
      className="fixed left-0 top-0 flex h-svh w-full items-center justify-center"
      role="status"
      aria-live="polite"
      aria-label="正在连接服务器"
    >
      <div className="flex flex-col items-center gap-4">
        <span className="material-symbols-outlined animate-spin text-[32px] leading-none text-accent/60" aria-hidden="true">progress_activity</span>
        <span className="text-xs text-amber-50/60">连接中…</span>
      </div>
    </div>
  )
}

export default Loading
