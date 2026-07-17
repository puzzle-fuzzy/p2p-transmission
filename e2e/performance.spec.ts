import { expect, test } from '@playwright/test'

type PerformanceObserverState = {
  cls: number
  lcp: number | null
  layoutShiftSupported: boolean
  largestContentfulPaintSupported: boolean
  observers: PerformanceObserver[]
}

type NavigationMetrics = {
  type: string
  startTime: number
  requestStart: number
  responseStart: number
  responseEnd: number
  domInteractive: number
  domContentLoadedEventEnd: number
  loadEventEnd: number
  duration: number
  transferSize: number
  encodedBodySize: number
  decodedBodySize: number
}

type PerformanceMetrics = {
  schemaVersion: 1
  url: string
  unit: 'milliseconds'
  navigation: NavigationMetrics | null
  fcp: number | null
  lcp: number | null
  cls: number
  appInteractive: number | null
  observerSupport: {
    layoutShift: boolean
    largestContentfulPaint: boolean
  }
  viewport: {
    width: number
    height: number
  }
}

declare global {
  interface Window {
    __p2pPerformanceObserverState?: PerformanceObserverState
  }
}

const isNullableNonNegativeNumber = (value: number | null) => (
  value === null || (Number.isFinite(value) && value >= 0)
)

test('the root records a stable performance baseline', async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    const state: PerformanceObserverState = {
      cls: 0,
      lcp: null,
      layoutShiftSupported: false,
      largestContentfulPaintSupported: false,
      observers: [],
    }
    window.__p2pPerformanceObserverState = state

    try {
      const layoutShiftObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const layoutShift = entry as PerformanceEntry & {
            hadRecentInput: boolean
            value: number
          }
          if (!layoutShift.hadRecentInput) state.cls += layoutShift.value
        }
      })
      layoutShiftObserver.observe({ type: 'layout-shift', buffered: true })
      state.layoutShiftSupported = true
      state.observers.push(layoutShiftObserver)
    } catch {
      // Chromium supports layout-shift entries; keep the zero baseline if unavailable.
    }

    try {
      const largestContentfulPaintObserver = new PerformanceObserver((list) => {
        const entries = list.getEntries()
        const latest = entries[entries.length - 1]
        if (latest) state.lcp = latest.startTime
      })
      largestContentfulPaintObserver.observe({
        type: 'largest-contentful-paint',
        buffered: true,
      })
      state.largestContentfulPaintSupported = true
      state.observers.push(largestContentfulPaintObserver)
    } catch {
      // Leave LCP as null when the browser does not expose the entry type.
    }
  })

  const response = await page.goto('/')
  expect(response?.ok()).toBe(true)
  const appMount = page.locator('#main')
  await expect(
    appMount.getByRole('heading', { name: '\u52a0\u5165\u623f\u95f4' }),
  ).toBeVisible()
  await expect(page.locator('#boot-fallback')).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => (
    performance.getEntriesByName('p2p-app-interactive', 'mark').length
  ))).toBe(1)
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  }))

  const metrics = await page.evaluate<PerformanceMetrics>(() => {
    const navigation = performance.getEntriesByType(
      'navigation',
    )[0] as PerformanceNavigationTiming | undefined
    const firstContentfulPaint = performance
      .getEntriesByName('first-contentful-paint', 'paint')[0]
    const interactiveMarks = performance
      .getEntriesByName('p2p-app-interactive', 'mark')
    const interactive = interactiveMarks[interactiveMarks.length - 1]
    const state = window.__p2pPerformanceObserverState

    return {
      schemaVersion: 1,
      url: window.location.href,
      unit: 'milliseconds',
      navigation: navigation
        ? {
            type: navigation.type,
            startTime: navigation.startTime,
            requestStart: navigation.requestStart,
            responseStart: navigation.responseStart,
            responseEnd: navigation.responseEnd,
            domInteractive: navigation.domInteractive,
            domContentLoadedEventEnd: navigation.domContentLoadedEventEnd,
            loadEventEnd: navigation.loadEventEnd,
            duration: navigation.duration,
            transferSize: navigation.transferSize,
            encodedBodySize: navigation.encodedBodySize,
            decodedBodySize: navigation.decodedBodySize,
          }
        : null,
      fcp: firstContentfulPaint?.startTime ?? null,
      lcp: state?.lcp ?? null,
      cls: state?.cls ?? 0,
      appInteractive: interactive?.startTime ?? null,
      observerSupport: {
        layoutShift: state?.layoutShiftSupported ?? false,
        largestContentfulPaint: state?.largestContentfulPaintSupported ?? false,
      },
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
      },
    }
  })

  const report = JSON.stringify(metrics, null, 2)
  console.log(`[performance-metrics]\n${report}`)
  await testInfo.attach('performance-metrics.json', {
    body: report,
    contentType: 'application/json',
  })

  expect(metrics).toMatchObject({
    schemaVersion: 1,
    unit: 'milliseconds',
  })
  expect(new URL(metrics.url).pathname).toBe('/')
  expect(metrics.navigation).not.toBeNull()
  expect(metrics.navigation?.type).toBe('navigate')
  expect(metrics.navigation?.startTime).toBe(0)
  expect(metrics.navigation?.responseEnd).toBeGreaterThanOrEqual(
    metrics.navigation?.responseStart ?? 0,
  )
  expect(metrics.fcp).not.toBeNull()
  expect(isNullableNonNegativeNumber(metrics.fcp)).toBe(true)
  expect(metrics.lcp).not.toBeNull()
  expect(isNullableNonNegativeNumber(metrics.lcp)).toBe(true)
  expect(metrics.appInteractive).not.toBeNull()
  expect(isNullableNonNegativeNumber(metrics.appInteractive)).toBe(true)
  if (metrics.fcp !== null && metrics.appInteractive !== null) {
    expect(metrics.appInteractive).toBeGreaterThanOrEqual(metrics.fcp)
  }
  expect(metrics.observerSupport).toEqual({
    layoutShift: true,
    largestContentfulPaint: true,
  })
  expect(metrics.viewport.width).toBeGreaterThan(0)
  expect(metrics.viewport.height).toBeGreaterThan(0)
  expect(Number.isFinite(metrics.cls)).toBe(true)
  expect(metrics.cls).toBeGreaterThanOrEqual(0)
  expect(metrics.cls).toBeLessThanOrEqual(0.1)
})
