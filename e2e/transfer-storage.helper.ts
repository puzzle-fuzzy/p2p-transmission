import type { Page } from '@playwright/test'

export const injectRecoverableWriteFailure = async (
  receiver: Page,
  options: { errorName: 'NotAllowedError' | 'QuotaExceededError'; fileName: string },
) => {
  await receiver.addInitScript(({ errorName, fileName }) => {
    const state = {
      aborts: 0,
      acknowledgements: 0,
      acknowledgementsAtPause: -1,
      failureInjected: false,
      pauseReasons: [] as string[],
      pickerCount: 0,
      resumeBytes: -1,
    }
    Object.defineProperty(window, '__recoverableStorageState', { value: state })
    const originalSend = RTCDataChannel.prototype.send
    Object.defineProperty(RTCDataChannel.prototype, 'send', {
      configurable: true,
      value(this: RTCDataChannel, data: unknown) {
        if (typeof data === 'string') {
          try {
            const message = JSON.parse(data) as {
              reason?: string
              resume?: Array<{ committed_bytes: number }>
              type?: string
            }
            if (message.type === 'segment_ack') {
              state.acknowledgements += 1
            } else if (message.type === 'stream_paused') {
              state.pauseReasons.push(message.reason ?? '')
              state.acknowledgementsAtPause = state.acknowledgements
            } else if (message.type === 'stream_ready' && state.pauseReasons.length > 0) {
              state.resumeBytes = message.resume?.[0]?.committed_bytes ?? -1
            }
          } catch {
            // Binary frames and non-control strings are irrelevant here.
          }
        }
        originalSend.call(this, data as never)
      },
    })
    Object.defineProperty(window, 'showSaveFilePicker', {
      configurable: true,
      value: async () => {
        state.pickerCount += 1
        const storage = navigator.storage as unknown as {
          getDirectory: () => Promise<{
            getFileHandle: (
              name: string,
              options: { create: boolean },
            ) => Promise<FileSystemFileHandle>
          }>
        }
        const root = await storage.getDirectory()
        const handle = await root.getFileHandle(fileName, { create: true })
        const createWritable = handle.createWritable.bind(handle)
        Object.defineProperty(handle, 'createWritable', {
          configurable: true,
          value: async (writableOptions?: { keepExistingData?: boolean }) => {
            const writable = await createWritable(writableOptions)
            return {
              abort: async () => {
                state.aborts += 1
                await writable.abort()
              },
              close: async () => writable.close(),
              write: async (command: unknown) => {
                if (!state.failureInjected) {
                  state.failureInjected = true
                  throw new DOMException('injected recoverable storage failure', errorName)
                }
                await writable.write(command as never)
              },
            }
          },
        })
        return handle
      },
    })
  }, options)
}
