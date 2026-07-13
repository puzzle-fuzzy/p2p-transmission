export type SpeedSample = {
  timestamp: number
  bytes: number
  totalBytes: number
}

export type SpeedTracker = {
  record(key: string, bytes: number, totalBytes: number): void
  getSpeed(key: string): number // bytes per second
  getEta(key: string): number | undefined // seconds remaining
  reset(key: string): void
  clear(): void
}

const MOVING_AVERAGE_WINDOW_MS = 2000
const MAX_SAMPLES = 20

export const createSpeedTracker = (now: () => number = Date.now): SpeedTracker => {
  const samples = new Map<string, SpeedSample[]>()

  const record = (key: string, bytes: number, totalBytes: number) => {
    const timestamp = now()
    if (
      !Number.isFinite(timestamp)
      || !Number.isFinite(bytes)
      || !Number.isFinite(totalBytes)
      || bytes < 0
      || totalBytes < 0
      || bytes > totalBytes
    ) {
      return
    }

    const keySamples = samples.get(key) ?? []

    // Only record if meaningful progress was made
    const last = keySamples[keySamples.length - 1]
    if (last && timestamp - last.timestamp < 200) return // Throttle to ~5 updates/sec
    if (last && bytes <= last.bytes) return // No progress

    keySamples.push({ timestamp, bytes, totalBytes })

    // Trim old samples outside the window
    const cutoff = timestamp - MOVING_AVERAGE_WINDOW_MS
    while (keySamples.length > 1 && keySamples[0].timestamp < cutoff) {
      keySamples.shift()
    }

    // Cap total samples
    while (keySamples.length > MAX_SAMPLES) {
      keySamples.shift()
    }

    samples.set(key, keySamples)
  }

  const getSpeed = (key: string): number => {
    const keySamples = samples.get(key)
    if (!keySamples || keySamples.length < 2) return 0

    const first = keySamples[0]
    const last = keySamples[keySamples.length - 1]
    const elapsed = last.timestamp - first.timestamp

    if (elapsed <= 0) return 0

    const speed = (last.bytes - first.bytes) / (elapsed / 1000)
    return Number.isFinite(speed) && speed > 0 ? speed : 0
  }

  const getEta = (key: string): number | undefined => {
    const speed = getSpeed(key)
    if (speed <= 0) return undefined

    const keySamples = samples.get(key)
    if (!keySamples || keySamples.length < 2) return undefined

    const latest = keySamples[keySamples.length - 1]
    const remaining = latest.totalBytes - latest.bytes

    if (remaining <= 0) return 0

    const eta = remaining / speed
    return Number.isFinite(eta) ? eta : undefined
  }

  const reset = (key: string) => {
    samples.delete(key)
  }

  const clear = () => {
    samples.clear()
  }

  return { record, getSpeed, getEta, reset, clear }
}

const KiB = 1024
const MiB = 1024 * KiB

export const formatSpeed = (bytesPerSecond: number): string => {
  if (bytesPerSecond < KiB) return `${Math.round(bytesPerSecond)} B/s`
  if (bytesPerSecond < MiB) return `${(bytesPerSecond / KiB).toFixed(1)} KiB/s`
  return `${(bytesPerSecond / MiB).toFixed(1)} MiB/s`
}

export const formatEta = (seconds: number | undefined): string => {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) {
    return ''
  }
  if (seconds < 60) return `${Math.ceil(seconds)}s`
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60)
    const s = Math.ceil(seconds % 60)
    return `${m}m${s}s`
  }
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return `${h}h${m}m`
}
