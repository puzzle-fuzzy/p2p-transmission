import { describe, expect, test } from 'vitest'
import { createSpeedTracker } from './transfer-speed-tracker'

const createClock = () => {
  let timestamp = 0

  return {
    now: () => timestamp,
    advance(milliseconds: number) {
      timestamp += milliseconds
    },
  }
}

describe('transfer speed tracker', () => {
  test('uses the injected clock to calculate speed and ETA from the stored total', () => {
    const clock = createClock()
    const tracker = createSpeedTracker(clock.now)

    tracker.record('outgoing:transfer-a:peer-a:file-a', 100, 1_100)
    clock.advance(500)
    tracker.record('outgoing:transfer-a:peer-a:file-a', 300, 1_100)

    expect(tracker.getSpeed('outgoing:transfer-a:peer-a:file-a')).toBe(400)
    expect(tracker.getEta('outgoing:transfer-a:peer-a:file-a')).toBe(2)
  })

  test('throttles rapid updates and ignores duplicate or regressing progress', () => {
    const clock = createClock()
    const tracker = createSpeedTracker(clock.now)
    const key = 'outgoing:transfer-a:peer-a:file-a'

    tracker.record(key, 0, 1_000)
    clock.advance(100)
    tracker.record(key, 100, 2_000)

    expect(tracker.getSpeed(key)).toBe(0)
    expect(tracker.getEta(key)).toBeUndefined()

    clock.advance(100)
    tracker.record(key, 200, 1_000)

    expect(tracker.getSpeed(key)).toBe(1_000)
    expect(tracker.getEta(key)).toBe(0.8)

    clock.advance(200)
    tracker.record(key, 200, 2_000)
    tracker.record(key, 150, 2_000)

    expect(tracker.getSpeed(key)).toBe(1_000)
    expect(tracker.getEta(key)).toBe(0.8)
  })

  test('ignores non-finite, negative, and out-of-range samples', () => {
    const clock = createClock()
    const tracker = createSpeedTracker(clock.now)
    const key = 'incoming:transfer-a:peer-a:file-a'

    tracker.record(key, Number.NaN, 1_000)
    tracker.record(key, 0, Number.POSITIVE_INFINITY)
    tracker.record(key, -1, 1_000)
    tracker.record(key, 1_001, 1_000)

    clock.advance(200)
    tracker.record(key, 200, 1_000)

    expect(tracker.getSpeed(key)).toBe(0)
    expect(tracker.getEta(key)).toBeUndefined()
  })

  test('reset removes one key while clear removes every key', () => {
    const clock = createClock()
    const tracker = createSpeedTracker(clock.now)
    const firstKey = 'outgoing:transfer-a:peer-a:file-a'
    const secondKey = 'incoming:transfer-b:peer-b:file-b'

    tracker.record(firstKey, 0, 1_000)
    tracker.record(secondKey, 0, 2_000)
    clock.advance(500)
    tracker.record(firstKey, 250, 1_000)
    tracker.record(secondKey, 500, 2_000)

    tracker.reset(firstKey)

    expect(tracker.getSpeed(firstKey)).toBe(0)
    expect(tracker.getEta(firstKey)).toBeUndefined()
    expect(tracker.getSpeed(secondKey)).toBe(1_000)
    expect(tracker.getEta(secondKey)).toBe(1.5)

    tracker.clear()

    expect(tracker.getSpeed(secondKey)).toBe(0)
    expect(tracker.getEta(secondKey)).toBeUndefined()
  })

  test('keeps compound keys for the same file isolated across peers and directions', () => {
    const clock = createClock()
    const tracker = createSpeedTracker(clock.now)
    const fastPeerKey = 'outgoing:transfer-a:peer-fast:file-shared'
    const slowPeerKey = 'outgoing:transfer-a:peer-slow:file-shared'
    const incomingKey = 'incoming:transfer-a:peer-fast:file-shared'

    tracker.record(fastPeerKey, 0, 1_000)
    tracker.record(slowPeerKey, 100, 2_000)
    tracker.record(incomingKey, 200, 3_000)
    clock.advance(1_000)
    tracker.record(fastPeerKey, 800, 1_000)
    tracker.record(slowPeerKey, 500, 2_000)
    tracker.record(incomingKey, 700, 3_000)

    expect(tracker.getSpeed(fastPeerKey)).toBe(800)
    expect(tracker.getEta(fastPeerKey)).toBe(0.25)
    expect(tracker.getSpeed(slowPeerKey)).toBe(400)
    expect(tracker.getEta(slowPeerKey)).toBe(3.75)
    expect(tracker.getSpeed(incomingKey)).toBe(500)
    expect(tracker.getEta(incomingKey)).toBe(4.6)
  })
})
