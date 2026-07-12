export type SpeedSample = {
  timestamp: number
  bytes: number
}

export type SpeedTracker = {
  record(fileId: string, bytes: number, totalBytes: number): void
  getSpeed(fileId: string): number // bytes per second
  getEta(fileId: string): number | undefined // seconds remaining
  reset(fileId: string): void
  clear(): void
}

const MOVING_AVERAGE_WINDOW_MS = 2000
const MAX_SAMPLES = 20

export const createSpeedTracker = (now: () => number = Date.now): SpeedTracker => {
  const samples = new Map<string, SpeedSample[]>()

  const record = (fileId: string, bytes: number, totalBytes: number) => {
    const t = now()
    const fileSamples = samples.get(fileId) ?? []

    // Only record if meaningful progress was made
    const last = fileSamples[fileSamples.length - 1]
    if (last && t - last.timestamp < 200) return // Throttle to ~5 updates/sec
    if (last && bytes <= last.bytes) return // No progress

    fileSamples.push({ timestamp: t, bytes })

    // Trim old samples outside the window
    const cutoff = t - MOVING_AVERAGE_WINDOW_MS
    while (fileSamples.length > 1 && fileSamples[0].timestamp < cutoff) {
      fileSamples.shift()
    }

    // Cap total samples
    while (fileSamples.length > MAX_SAMPLES) {
      fileSamples.shift()
    }

    samples.set(fileId, fileSamples)
  }

  const getSpeed = (fileId: string): number => {
    const fileSamples = samples.get(fileId)
    if (!fileSamples || fileSamples.length < 2) return 0

    const first = fileSamples[0]
    const last = fileSamples[fileSamples.length - 1]
    const elapsed = last.timestamp - first.timestamp

    if (elapsed <= 0) return 0

    return (last.bytes - first.bytes) / (elapsed / 1000)
  }

  const getEta = (fileId: string, totalBytes: number): number | undefined => {
    const speed = getSpeed(fileId)
    if (speed <= 0) return undefined

    const fileSamples = samples.get(fileId)
    if (!fileSamples || fileSamples.length < 2) return undefined

    const latestBytes = fileSamples[fileSamples.length - 1].bytes
    const remaining = totalBytes - latestBytes

    if (remaining <= 0) return 0

    return remaining / speed
  }

  const reset = (fileId: string) => {
    samples.delete(fileId)
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
