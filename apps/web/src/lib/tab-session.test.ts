// @vitest-environment jsdom

import { beforeEach, describe, expect, test } from 'vitest'
import { getTabStorageKey } from './tab-session'

describe('getTabStorageKey', () => {
  beforeEach(() => {
    window.name = ''
  })

  test('creates and reuses one namespaced identity for the current tab', () => {
    const visitorKey = getTabStorageKey('p2p.visitorSession')
    const assignedName = window.name

    expect(assignedName).toMatch(/^p2p-transmission:/u)
    expect(visitorKey).toBe(`p2p.visitorSession:${assignedName}`)
    expect(getTabStorageKey('p2p.roomSession')).toBe(
      `p2p.roomSession:${assignedName}`,
    )
  })

  test('preserves valid existing tab names and isolates different tabs', () => {
    const firstTab = { name: 'p2p-transmission:first' }
    const secondTab = { name: 'p2p-transmission:second' }

    expect(getTabStorageKey('session', firstTab)).toBe(
      'session:p2p-transmission:first',
    )
    expect(getTabStorageKey('session', secondTab)).toBe(
      'session:p2p-transmission:second',
    )
  })

  test('replaces an unrelated window name with the product namespace', () => {
    const target = { name: 'unrelated-window-name' }

    const key = getTabStorageKey('session', target)

    expect(target.name).toMatch(/^p2p-transmission:/u)
    expect(key).toBe(`session:${target.name}`)
  })
})
