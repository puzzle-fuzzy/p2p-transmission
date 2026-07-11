import { useCallback, useEffect, useState } from 'react'

export type ToastState = {
  id: number
  message: string
}

export const useToast = () => {
  const [toast, setToast] = useState<ToastState | undefined>()

  const show = useCallback((message: string) => {
    setToast({
      id: Date.now(),
      message,
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
