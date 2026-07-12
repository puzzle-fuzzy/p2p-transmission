type NotificationOptions = {
  title: string
  body: string
  tag?: string
}

let permissionRequested = false
let permissionGranted = false

export const requestNotificationPermission = async (): Promise<boolean> => {
  if (!('Notification' in window)) return false

  if (Notification.permission === 'granted') {
    permissionGranted = true
    return true
  }

  if (Notification.permission === 'denied' || permissionRequested) {
    return permissionGranted
  }

  permissionRequested = true
  try {
    const result = await Notification.requestPermission()
    permissionGranted = result === 'granted'
    return permissionGranted
  } catch {
    return false
  }
}

export const sendNotification = ({ title, body, tag }: NotificationOptions) => {
  if (!('Notification' in window)) return
  if (Notification.permission !== 'granted') return

  try {
    // Don't notify if the tab is focused
    if (!document.hidden) return

    const notification = new Notification(title, {
      body,
      tag: tag ?? 'p2p-transmission',
      icon: '/favicon.svg',
    })

    notification.onclick = () => {
      window.focus()
      notification.close()
    }

    // Auto-close after 8 seconds
    setTimeout(() => notification.close(), 8000)
  } catch {
    // Notification failed silently — non-critical
  }
}

// Track visibility to request permission when user is active
export const setupNotificationPermissionPrompt = () => {
  if (!('Notification' in window) || Notification.permission !== 'default') return

  const handler = () => {
    if (document.hidden) return
    // Request permission after a user interaction
    document.removeEventListener('visibilitychange', handler)
    void requestNotificationPermission()
  }

  document.addEventListener('visibilitychange', handler)
}
