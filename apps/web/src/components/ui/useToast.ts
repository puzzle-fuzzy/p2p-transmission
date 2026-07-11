import { useCallback, useEffect, useState } from 'react'

export type ToastTone = 'error' | 'success' | 'info'

export type ToastState = {
  id: number
  message: string
  tone: ToastTone
}

export const useToast = () => {
  const [toast, setToast] = useState<ToastState | undefined>()

  const show = useCallback((message: string, tone: ToastTone = 'error') => {
    setToast({
      id: Date.now(),
      message,
      tone,
    })
  }, [])

  const dismiss = useCallback(() => {
    setToast(undefined)
  }, [])

  useEffect(() => {
    if (!toast) return undefined

    const timer = window.setTimeout(() => {
      setToast(undefined)
    }, 3200)

    return () => window.clearTimeout(timer)
  }, [toast])

  return {
    toast,
    show,
    dismiss,
  }
}
