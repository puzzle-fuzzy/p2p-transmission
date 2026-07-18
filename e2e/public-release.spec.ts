import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
  type TestInfo,
} from '@playwright/test'
import { Buffer } from 'node:buffer'
import { readFile } from 'node:fs/promises'

import { connectSingleReceiverRoom } from './room.helper'
import { useFileInputFallback } from './transfer.helper'

interface RelayStateSummary {
  candidateTypes: string[]
  connectionCount: number
  connectionStates: string[]
  policies: string[]
}

async function requireRelayConnections(context: BrowserContext) {
  await context.addInitScript(() => {
    const NativePeerConnection = window.RTCPeerConnection
    const connections: RTCPeerConnection[] = []
    const policies: string[] = []

    class RelayOnlyPeerConnection extends NativePeerConnection {
      constructor(configuration: RTCConfiguration = {}) {
        const relayConfiguration: RTCConfiguration = {
          ...configuration,
          iceTransportPolicy: 'relay',
        }
        super(relayConfiguration)
        connections.push(this)
        policies.push(this.getConfiguration().iceTransportPolicy ?? '')
      }
    }

    Object.defineProperty(window, '__p2pPublicRelayState', {
      configurable: false,
      value: { connections, policies },
    })
    Object.defineProperty(window, 'RTCPeerConnection', {
      configurable: true,
      value: RelayOnlyPeerConnection,
      writable: true,
    })
  })
}

async function relayState(page: Page): Promise<RelayStateSummary> {
  return page.evaluate(async () => {
    const state = (window as unknown as {
      __p2pPublicRelayState: {
        connections: RTCPeerConnection[]
        policies: string[]
      }
    }).__p2pPublicRelayState
    const candidateTypes = new Set<string>()

    for (const connection of state.connections) {
      const report = await connection.getStats()
      report.forEach(stat => {
        if (stat.type === 'local-candidate' && typeof stat.candidateType === 'string') {
          candidateTypes.add(stat.candidateType)
        }
      })
    }

    return {
      candidateTypes: [...candidateTypes],
      connectionCount: state.connections.length,
      connectionStates: [...new Set(
        state.connections.map(connection => connection.connectionState),
      )],
      policies: [...new Set(state.policies)],
    }
  })
}

async function allocateRelayCandidate(page: Page) {
  const sessionReady = page.waitForResponse(response => (
    new URL(response.url()).pathname === '/api/session'
    && response.request().method() === 'POST'
    && response.ok()
  ))
  await page.goto('/')
  await sessionReady

  return page.evaluate(async () => {
    const response = await fetch('/api/rtc/config', { credentials: 'same-origin' })
    if (!response.ok) {
      throw new Error(`RTC configuration returned HTTP ${response.status}`)
    }
    const payload = await response.json() as {
      ice_servers: Array<{
        credential?: string
        credential_type?: RTCIceCredentialType
        urls: string[]
        username?: string
      }>
    }
    const peer = new RTCPeerConnection({
      iceServers: payload.ice_servers.map(server => ({
        credential: server.credential,
        credentialType: server.credential_type,
        urls: server.urls,
        username: server.username,
      })),
      iceTransportPolicy: 'relay',
    })
    peer.createDataChannel('turn-health')

    try {
      const candidate = new Promise<{ candidateType: string; urls: string[] }>((resolve, reject) => {
        const timeout = window.setTimeout(
          () => reject(new Error('TURN did not produce a relay candidate within 15 seconds')),
          15_000,
        )
        peer.addEventListener('icecandidate', event => {
          const candidateType = event.candidate?.type
          if (candidateType === 'relay') {
            window.clearTimeout(timeout)
            resolve({
              candidateType,
              urls: payload.ice_servers.flatMap(server => server.urls),
            })
          } else if (!event.candidate && peer.iceGatheringState === 'complete') {
            window.clearTimeout(timeout)
            reject(new Error('TURN ICE gathering completed without a relay candidate'))
          }
        })
      })
      await peer.setLocalDescription(await peer.createOffer())
      return await candidate
    } finally {
      peer.close()
    }
  })
}

async function verifyPublicTransfer({
  baseURL,
  browser,
  relayOnly,
  testInfo,
}: {
  baseURL: string | undefined
  browser: Browser
  relayOnly: boolean
  testInfo: TestInfo
}) {
  const ownerContext = await browser.newContext({ baseURL })
  const receiverContext = await browser.newContext({ baseURL, acceptDownloads: true })
  if (relayOnly) {
    await requireRelayConnections(ownerContext)
    await requireRelayConnections(receiverContext)
  }

  const owner = await ownerContext.newPage()
  const receiver = await receiverContext.newPage()
  const ownerSockets: string[] = []
  const receiverSockets: string[] = []
  owner.on('websocket', socket => ownerSockets.push(socket.url()))
  receiver.on('websocket', socket => receiverSockets.push(socket.url()))

  const payload = Buffer.alloc(32 * 1024 + (relayOnly ? 17 : 11))
  for (let index = 0; index < payload.length; index += 1) {
    payload[index] = (index * 29 + 11) % 256
  }

  try {
    try {
      await connectSingleReceiverRoom(owner, receiver, {
        beforeOwnerNavigation: useFileInputFallback,
        readyTimeout: 30_000,
      })
    } catch (error) {
      if (relayOnly) {
        await testInfo.attach('relay-state.json', {
          body: Buffer.from(JSON.stringify({
            owner: await relayState(owner),
            receiver: await relayState(receiver),
          }, null, 2)),
          contentType: 'application/json',
        })
      }
      throw error
    }

    expect(ownerSockets.some(url => url.startsWith('wss://'))).toBe(true)
    expect(receiverSockets.some(url => url.startsWith('wss://'))).toBe(true)

    await owner.locator('#transfer-file-input').setInputFiles({
      name: relayOnly ? 'public-relay-check.bin' : 'public-direct-check.bin',
      mimeType: 'application/octet-stream',
      buffer: payload,
    })
    const offer = receiver.getByRole('dialog', { name: '接收文件' })
    await expect(offer).toContainText(
      relayOnly ? 'public-relay-check.bin' : 'public-direct-check.bin',
    )
    await offer.getByRole('button', { name: '接收文件' }).click()

    await expect(owner.getByRole('heading', { name: '文件发送完成' })).toBeVisible()
    await expect(receiver.getByRole('heading', { name: '文件接收完成' })).toBeVisible()

    const [download] = await Promise.all([
      receiver.waitForEvent('download'),
      receiver.getByRole('link', { name: '保存文件' }).click(),
    ])
    const downloadPath = await download.path()
    expect(downloadPath).not.toBeNull()
    expect(await readFile(downloadPath ?? '')).toEqual(payload)

    if (relayOnly) {
      for (const summary of [await relayState(owner), await relayState(receiver)]) {
        expect(summary.connectionCount).toBeGreaterThan(0)
        expect(summary.policies.every(policy => policy === 'relay')).toBe(true)
        expect(summary.connectionStates).toContain('connected')
        expect(summary.candidateTypes).toContain('relay')
      }
    }
  } finally {
    await receiverContext.close()
    await ownerContext.close()
  }
}

test('the public release transfers a small file over WSS', async ({
  baseURL,
  browser,
}, testInfo) => {
  await verifyPublicTransfer({ baseURL, browser, relayOnly: false, testInfo })
})

test('the public TURN credentials allocate a relay ICE candidate', async ({ page }) => {
  const result = await allocateRelayCandidate(page)
  expect(result.candidateType).toBe('relay')
  expect(result.urls.some(url => url.startsWith('turn:') || url.startsWith('turns:'))).toBe(true)
})

test('the public release transfers a small file through TURN relay', async ({
  baseURL,
  browser,
}, testInfo) => {
  await verifyPublicTransfer({ baseURL, browser, relayOnly: true, testInfo })
})
