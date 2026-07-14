import { describe, expect, test, vi } from 'vitest'
import {
  createPastedTextFile,
  readPasteCandidate,
} from './paste-upload'

const createClipboardData = (
  files: readonly File[] = [],
  text = '',
): DataTransfer => ({
  files,
  getData: vi.fn((format: string) => format === 'text/plain' ? text : ''),
} as unknown as DataTransfer)

describe('readPasteCandidate', () => {
  test('prefers clipboard files over their text representation', () => {
    const file = new File(['image'], '截图.png', { type: 'image/png' })
    const data = createClipboardData([file], '截图的文本表示')

    expect(readPasteCandidate(data)).toEqual({
      kind: 'files',
      files: [file],
    })
  })

  test('returns plain text when no clipboard files exist', () => {
    const data = createClipboardData([], '第一行\n第二行')

    expect(readPasteCandidate(data)).toEqual({
      kind: 'text',
      text: '第一行\n第二行',
    })
  })

  test('returns undefined for an empty clipboard payload', () => {
    expect(readPasteCandidate(createClipboardData())).toBeUndefined()
  })
})

describe('createPastedTextFile', () => {
  test('creates a UTF-8 text file with a collision-safe name', async () => {
    const file = createPastedTextFile(
      '保留换行\n和 Unicode 🙂',
      ['粘贴内容.txt', '粘贴内容 (2).txt'],
      123,
    )

    expect(file.name).toBe('粘贴内容 (3).txt')
    expect(file.type).toBe('text/plain')
    expect(file.lastModified).toBe(123)
    expect(await file.text()).toBe('保留换行\n和 Unicode 🙂')
  })

  test('increments names case-insensitively', () => {
    const file = createPastedTextFile(
      'content',
      ['粘贴内容.TXT'],
      456,
    )

    expect(file.name).toBe('粘贴内容 (2).txt')
  })
})
