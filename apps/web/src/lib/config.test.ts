import { describe, expect, test } from 'vitest'
import { parseIceServerUrls } from './config'

describe('runtime config', () => {
  test('uses the public STUN default when no URLs are configured', () => {
    expect(parseIceServerUrls()).toEqual(['stun:stun.l.google.com:19302'])
  })

  test('normalizes comma-separated STUN URLs', () => {
    expect(parseIceServerUrls(' stun:one.example ,stun:two.example ')).toEqual([
      'stun:one.example',
      'stun:two.example',
    ])
  })
})
