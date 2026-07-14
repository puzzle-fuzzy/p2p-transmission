import type { ToastState, ToastTone } from './useToast'

type ToastViewportProps = {
  toast?: ToastState
  onDismiss(): void
}

const toneStyles: Record<ToastTone, {
  container: string
  dismiss: string
  icon: string
}> = {
  error: {
    container: 'bg-surface-elevated text-amber-50/80',
    dismiss: 'text-amber-50/50 hover:text-amber-50/90',
    icon: 'error',
  },
  success: {
    container: 'bg-surface-elevated text-amber-50/80',
    dismiss: 'text-amber-50/50 hover:text-amber-50/90',
    icon: 'check_circle',
  },
  info: {
    container: 'bg-surface-elevated text-amber-50/70',
    dismiss: 'text-amber-50/60 hover:text-amber-50/80',
    icon: 'info',
  },
}

export default function ToastViewport({ toast, onDismiss }: ToastViewportProps) {
  if (!toast) return null

  const styles = toneStyles[toast.tone]

  return (
    <div
      className="fixed right-4 top-4 z-50 w-[min(320px,calc(100vw-2rem))] sm:right-6 sm:top-6"
      role={toast.tone === 'error' ? 'alert' : 'status'}
      aria-live={toast.tone === 'error' ? 'assertive' : 'polite'}
      aria-atomic="true"
    >
      <div className={`toast-surface flex min-h-10 items-center gap-2.5 rounded-xl px-3 py-2.5 ${styles.container}`}>
        <span
          className="material-symbols-outlined shrink-0 leading-none"
          style={{ fontSize: '16px' }}
          aria-hidden="true"
        >
          {styles.icon}
        </span>
        <span className="min-w-0 flex-1 text-xs">{toast.message}</span>
        <button
          type="button"
          className={`-mr-2 flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${styles.dismiss}`}
          onClick={onDismiss}
          aria-label="关闭提示"
        >
          <span
            className="material-symbols-outlined leading-none"
            style={{ fontSize: '14px' }}
            aria-hidden="true"
          >
            close
          </span>
        </button>
      </div>
    </div>
  )
}
