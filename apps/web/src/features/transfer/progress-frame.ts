export type ProgressFrameEvent = {
  peerId: string
  fileId: string
}

export type ProgressFrameScheduler<Event extends ProgressFrameEvent> = {
  push(event: Event): void
  clear(): void
}

export type ProgressFrameSchedulerOptions<Event extends ProgressFrameEvent> = {
  requestFrame(callback: FrameRequestCallback): number
  cancelFrame(frame: number): void
  onFlush(events: readonly Event[]): void
}

const compareProgressEvents = <Event extends ProgressFrameEvent>(
  left: Event,
  right: Event,
) => {
  if (left.peerId < right.peerId) return -1
  if (left.peerId > right.peerId) return 1
  if (left.fileId < right.fileId) return -1
  if (left.fileId > right.fileId) return 1
  return 0
}

const progressKey = (event: ProgressFrameEvent) =>
  event.peerId + '\u0000' + event.fileId

export const createProgressFrameScheduler = <Event extends ProgressFrameEvent>({
  requestFrame,
  cancelFrame,
  onFlush,
}: ProgressFrameSchedulerOptions<Event>): ProgressFrameScheduler<Event> => {
  const pending = new Map<string, Event>()
  let frame: number | undefined
  let frameGeneration = 0

  const schedule = () => {
    if (frame !== undefined) return

    const generation = ++frameGeneration
    frame = requestFrame(() => {
      if (generation !== frameGeneration) return

      frame = undefined
      const events = Array.from(pending.values()).sort(compareProgressEvents)
      pending.clear()
      if (events.length > 0) onFlush(events)
    })
  }

  return {
    push(event) {
      pending.set(progressKey(event), event)
      schedule()
    },
    clear() {
      frameGeneration += 1
      if (frame !== undefined) cancelFrame(frame)
      frame = undefined
      pending.clear()
    },
  }
}
