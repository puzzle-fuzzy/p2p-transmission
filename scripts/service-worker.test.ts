import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const ORIGIN = 'https://p2p.yxswy.com'
const RELEASE = '2.0.1-abcdef0'

type ServiceWorkerContract = {
  applicationShellMatchesRelease: (html: string) => boolean
  currentReleaseShellAsset: (url: URL) => boolean
  networkFirstApplication: (request: Request) => Promise<Response>
}

const currentShell = (release = RELEASE) => `<!doctype html>
  <link rel="stylesheet" href="/shell/app-shell.css?v=${release}">
  <script src="/shell/room-restore.js?v=${release}"></script>
  <script src="/shell/app-shell.js?v=${release}"></script>`

const loadWorker = async () => {
  const puts: Array<[RequestInfo | URL, Response]> = []
  const cache = {
    match: async () => undefined,
    put: async (request: RequestInfo | URL, response: Response) => {
      puts.push([request, response])
    },
  }
  const context = vm.createContext({
    URL,
    Request,
    Response,
    Set,
    encodeURIComponent,
    caches: {
      keys: async () => [],
      open: async () => cache,
    },
    fetch: async () => responseAtRoot(currentShell()),
    self: {
      location: { origin: ORIGIN },
      addEventListener: () => undefined,
      clients: { claim: async () => undefined },
      skipWaiting: async () => undefined,
    },
  })
  const source = (await readFile('rust/apps/server/assets/sw.js', 'utf8'))
    .replaceAll('__P2P_RELEASE__', RELEASE)
  vm.runInContext(`${source}\n;globalThis.contract = {
    applicationShellMatchesRelease,
    currentReleaseShellAsset,
    networkFirstApplication,
  };`, context)
  return {
    context,
    contract: context.contract as ServiceWorkerContract,
    puts,
  }
}

const responseAtRoot = (html: string) => {
  const response = new Response(html, {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  })
  Object.defineProperty(response, 'url', { value: `${ORIGIN}/` })
  return response
}

describe('service worker release cache contract', () => {
  test('accepts exactly the three shell references from its own release', async () => {
    const { contract } = await loadWorker()
    expect(contract.applicationShellMatchesRelease(currentShell())).toBe(true)
    expect(contract.applicationShellMatchesRelease(currentShell('2.0.1-stale'))).toBe(false)
    expect(contract.applicationShellMatchesRelease(
      `${currentShell()}<script src="/shell/app-shell.js?v=${RELEASE}"></script>`,
    )).toBe(false)
  })

  test('treats only the exact current release URL as cache-first', async () => {
    const { contract } = await loadWorker()
    expect(contract.currentReleaseShellAsset(
      new URL(`/shell/app-shell.css?v=${RELEASE}`, ORIGIN),
    )).toBe(true)
    expect(contract.currentReleaseShellAsset(
      new URL('/shell/app-shell.css?v=2.0.1-stale', ORIGIN),
    )).toBe(false)
    expect(contract.currentReleaseShellAsset(
      new URL(`/shell/app-shell.css?v=${RELEASE}&preview=1`, ORIGIN),
    )).toBe(false)
  })

  test('does not write a different release root into the current cache', async () => {
    const { context, contract, puts } = await loadWorker()
    context.fetch = async () => responseAtRoot(currentShell('2.0.1-next'))
    await contract.networkFirstApplication(new Request(`${ORIGIN}/`))
    expect(puts).toHaveLength(0)

    context.fetch = async () => responseAtRoot(currentShell())
    await contract.networkFirstApplication(new Request(`${ORIGIN}/`))
    expect(puts).toHaveLength(1)
    expect(puts[0]?.[0]).toBe('/')
  })
})
