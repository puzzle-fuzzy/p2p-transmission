const VISITOR_TAB_NAME_PREFIX = 'p2p-transmission:'

const createBrowserId = () => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

const getDefaultTarget = (): Pick<Window, 'name'> | undefined => {
  if (typeof window === 'undefined') return undefined

  return window
}

export const getTabStorageKey = (
  baseKey: string,
  targetWindow: Pick<Window, 'name'> | undefined = getDefaultTarget(),
) => {
  if (!targetWindow) return baseKey

  if (!targetWindow.name.startsWith(VISITOR_TAB_NAME_PREFIX)) {
    targetWindow.name = `${VISITOR_TAB_NAME_PREFIX}${createBrowserId()}`
  }

  return `${baseKey}:${targetWindow.name}`
}
