import { describe, expect, test } from 'vitest'
import { getAppVersion } from './app-meta'

describe('app version metadata', () => {
  test('uses the development label when no build version is injected', () => {
    expect(getAppVersion({})).toBe('开发构建')
    expect(getAppVersion({ VITE_APP_VERSION: undefined })).toBe('开发构建')
    expect(getAppVersion({ VITE_APP_VERSION: '   ' })).toBe('开发构建')
  })

  test('returns a non-empty build version without adding a prefix', () => {
    expect(getAppVersion({ VITE_APP_VERSION: '1.0.50' })).toBe('1.0.50')
    expect(getAppVersion({ VITE_APP_VERSION: ' 1.0.50 ' })).toBe('1.0.50')
  })
})
