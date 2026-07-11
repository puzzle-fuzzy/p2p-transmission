import type { ToastState } from './useToast'

type ToastViewportProps = {
  toast?: ToastState
  onDismiss(): void
}

export default function ToastViewport({ toast, onDismiss }: ToastViewportProps) {
  if (!toast) return null

  return (
    <div className="fixed left-1/2 top-6 z-50 w-[min(360px,calc(100vw-32px))] -translate-x-1/2">
      <div className="flex items-center gap-3 rounded-xl border border-red-500/20 bg-[#332729] px-4 py-3 text-red-300">
        <span className="material-symbols-outlined leading-none shrink-0" style={{ fontSize: '16px' }}>error</span>
        <span className="min-w-0 flex-1 text-xs">{toast.message}</span>
        <button
          className="text-red-300/50 hover:text-red-300 transition-colors cursor-pointer"
          onClick={onDismiss}
          aria-label="关闭提示"
        >
          <span className="material-symbols-outlined leading-none" style={{ fontSize: '14px' }}>close</span>
        </button>
      </div>
    </div>
  )
}
