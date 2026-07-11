function Loading() {
  return (
    <div className="w-full h-svh flex justify-center items-center fixed top-0 left-0">
      <div className="flex flex-col items-center gap-4">
        <span className="material-symbols-outlined text-[32px] leading-none text-accent/60 animate-spin">progress_activity</span>
        <span className="text-amber-50/30 text-xs">连接中…</span>
      </div>
    </div>
  )
}

export default Loading
