/// <reference types="node" />
// @vitest-environment node

import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, test, vi } from 'vitest'

type WorkerEvent = {
  request?: {
    headers: Headers
    method: string
    url: string
  }
  respondWith?: (response: Promise<unknown>) => void
  waitUntil?: (work: Promise<unknown>) => void
}

const workerSource = readFileSync(
  new URL('../public/sw.js', import.meta.url),
  'utf8',
)

const createHarness = () => {
  const listeners = new Map<string, (event: WorkerEvent) => void>()
  const cache = {
    addAll: vi.fn(async () => undefined),
    match: vi.fn(async () => ({ source: 'current-cache' })),
    put: vi.fn(async () => undefined),
  }
  const caches = {
    delete: vi.fn(async () => true),
    keys: vi.fn(async () => [
      'unrelated-cache',
      'p2p-transmission-v1',
      'p2p-transmission-static',
    ]),
    match: vi.fn(async () => ({ source: 'unrelated-cache' })),
    open: vi.fn(async () => cache),
  }
  const self = {
    addEventListener: (
      type: string,
      listener: (event: WorkerEvent) => void,
    ) => listeners.set(type, listener),
    clients: { claim: vi.fn(async () => undefined) },
    location: { origin: 'https://files.example' },
    skipWaiting: vi.fn(),
  }

  runInNewContext(workerSource, {
    URL,
    caches,
    fetch: vi.fn(),
    self,
  })

  return { cache, caches, listeners, self }
}

describe('service worker cache boundary', () => {
  test.each([
    'https://files.example/',
    'https://files.example/index.html',
    'https://files.example/assets/index-hash.js',
    'https://files.example/v1/rooms/123456/join-requests/req_secret',
    'https://files.example/icons.svg?invite=inv_secret',
    'https://api.example/icons.svg',
  ])('never intercepts navigation, API, dynamic, query, or cross-origin GET %s', url => {
    const harness = createHarness()
    const respondWith = vi.fn()

    harness.listeners.get('fetch')?.({
      request: { headers: new Headers(), method: 'GET', url },
      respondWith,
    })

    expect(respondWith).not.toHaveBeenCalled()
  })

  test('never intercepts an authenticated request even for a static path', () => {
    const harness = createHarness()
    const respondWith = vi.fn()

    harness.listeners.get('fetch')?.({
      request: {
        headers: new Headers({ authorization: 'Bearer tok_secret' }),
        method: 'GET',
        url: 'https://files.example/icons.svg',
      },
      respondWith,
    })

    expect(respondWith).not.toHaveBeenCalled()
  })

  test('intercepts only an exact allowlisted static asset', async () => {
    const harness = createHarness()
    let response: Promise<unknown> | undefined

    harness.listeners.get('fetch')?.({
      request: {
        headers: new Headers(),
        method: 'GET',
        url: 'https://files.example/icons.svg',
      },
      respondWith: value => {
        response = value
      },
    })

    expect(response).toBeDefined()
    await response
    expect(harness.cache.match).toHaveBeenCalledOnce()
    expect(harness.caches.match).not.toHaveBeenCalled()
  })

  test('replaces the legacy cache without deleting unrelated storage', async () => {
    const harness = createHarness()
    let activation: Promise<unknown> | undefined

    harness.listeners.get('activate')?.({
      waitUntil: value => {
        activation = value
      },
    })

    expect(activation).toBeDefined()
    await activation
    expect(harness.caches.delete).toHaveBeenCalledTimes(1)
    expect(harness.caches.delete).toHaveBeenCalledWith('p2p-transmission-v1')
    expect(harness.self.clients.claim).toHaveBeenCalledOnce()
  })
})
