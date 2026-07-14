import type { ToastState, ToastTone } from './useToast'

type ToastViewportProps = {
  toast?: ToastState
  onDismiss(): void
}

const toneStyles: Record<ToastTone, {
  container: string
  dismiss: string
  icon: string
  iconContainer: string
  timer: string
}> = {
  error: {
    container: 'border border-amber-50/15 bg-[#242424] text-amber-50/90',
    dismiss: 'text-amber-50/50 hover:text-amber-50/90',
    icon: 'error',
    iconContainer: 'bg-amber-50/10 text-amber-50/90',
    timer: 'bg-amber-50/65',
  },
  success: {
    container: 'border border-accent/35 bg-[#242424] text-amber-50/90',
    dismiss: 'text-amber-50/50 hover:text-amber-50/90',
    icon: 'check_circle',
    iconContainer: 'bg-accent/25 text-amber-50/90',
    timer: 'bg-accent',
  },
  info: {
    container: 'border border-white/15 bg-[#242424] text-amber-50/85',
    dismiss: 'text-amber-50/60 hover:text-amber-50/80',
    icon: 'info',
    iconContainer: 'bg-white/10 text-amber-50/80',
    timer: 'bg-white/55',
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
      <div
        key={toast.id}
        className={`toast-surface relative flex min-h-14 items-center gap-3 overflow-hidden rounded-xl px-3.5 py-3 ${styles.container}`}
      >
        <span
          className={`flex size-8 shrink-0 items-center justify-center rounded-full ${styles.iconContainer}`}
          aria-hidden="true"
        >
          <span
            className="material-symbols-outlined leading-none"
            style={{ fontSize: '17px' }}
            aria-hidden="true"
          >
            {styles.icon}
          </span>
        </span>
        <span className="min-w-0 flex-1 text-sm font-medium leading-5">{toast.message}</span>
        <button
          type="button"
          className={`-mr-2 flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-lg transition-colors hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${styles.dismiss}`}
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
        <span
          className={`toast-timer absolute inset-x-0 bottom-0 h-0.5 ${styles.timer}`}
          aria-hidden="true"
        />
      </div>
    </div>
  )
}
