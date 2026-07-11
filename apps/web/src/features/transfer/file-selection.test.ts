import {
  MAX_FILE_BATCH_BYTES,
  MAX_FILE_COUNT,
} from '@p2p/contracts'
import { describe, expect, test, vi } from 'vitest'
import {
  addFileSelections,
  removeFileSelection,
  totalSelectionBytes,
  type FileSelection,
} from './file-selection'

const createFile = (
  name: string,
  size: number,
  lastModified = 1,
  type = '',
) => ({ name, size, type, lastModified }) as File

const createIds = () => {
  let index = 0

  return vi.fn(() => `file_${String(++index)}`)
}

describe('file selection', () => {
  test('appends immutable selections with stable generated IDs', () => {
    const existingFile = createFile('existing.bin', 2)
    const existing: FileSelection[] = [{ fileId: 'file_existing', file: existingFile }]
    const incoming = [
      createFile('a.bin', 1),
      createFile('b.bin', 3),
    ]
    const createId = createIds()

    const result = addFileSelections(existing, incoming, createId)

    expect(result).toEqual({
      ok: true,
      selections: [
        { fileId: 'file_existing', file: existingFile },
        { fileId: 'file_1', file: incoming[0] },
        { fileId: 'file_2', file: incoming[1] },
      ],
    })
    expect(result.ok && result.selections).not.toBe(existing)
    expect(existing).toEqual([{ fileId: 'file_existing', file: existingFile }])
    expect(createId).toHaveBeenCalledTimes(2)
  })

  test('allows equal metadata from different File objects', () => {
    const first = createFile('same.bin', 10, 7)
    const second = createFile('same.bin', 10, 7)

    const result = addFileSelections([], [first, second], createIds())

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.selections.map(selection => selection.file)).toEqual([first, second])
  })

  test('rejects the same File object from existing or incoming selections', () => {
    const file = createFile('duplicate.bin', 10)
    const existing = [{ fileId: 'file_existing', file }]
    const existingId = vi.fn(() => 'unused')
    const incomingId = vi.fn(() => 'unused')

    expect(addFileSelections(existing, [file], existingId)).toMatchObject({
      ok: false,
      code: 'DUPLICATE_FILE',
    })
    expect(addFileSelections([], [file, file], incomingId)).toMatchObject({
      ok: false,
      code: 'DUPLICATE_FILE',
    })
    expect(existing).toEqual([{ fileId: 'file_existing', file }])
    expect(existingId).not.toHaveBeenCalled()
    expect(incomingId).not.toHaveBeenCalled()
  })

  test('accepts exactly ten files and rejects the eleventh before creating IDs', () => {
    const tenFiles = Array.from(
      { length: MAX_FILE_COUNT },
      (_, index) => createFile(`${String(index)}.bin`, 1),
    )
    const createId = createIds()
    const accepted = addFileSelections([], tenFiles, createId)
    if (!accepted.ok) throw new Error('expected ten files to be accepted')
    const rejectedId = vi.fn(() => 'unused')

    const rejected = addFileSelections(
      accepted.selections,
      [createFile('eleventh.bin', 1)],
      rejectedId,
    )

    expect(accepted.selections).toHaveLength(MAX_FILE_COUNT)
    expect(rejected).toMatchObject({ ok: false, code: 'FILE_COUNT_LIMIT' })
    expect(rejectedId).not.toHaveBeenCalled()
    expect(accepted.selections).toHaveLength(MAX_FILE_COUNT)
  })

  test('accepts exactly 100 MiB including empty files and rejects one byte over', () => {
    const exact = createFile('exact.bin', MAX_FILE_BATCH_BYTES)
    const empty = createFile('empty.bin', 0)
    const accepted = addFileSelections([], [exact, empty], createIds())
    if (!accepted.ok) throw new Error('expected exact limit to be accepted')
    const createId = vi.fn(() => 'unused')

    const rejected = addFileSelections(
      accepted.selections,
      [createFile('over.bin', 1)],
      createId,
    )

    expect(totalSelectionBytes(accepted.selections)).toBe(MAX_FILE_BATCH_BYTES)
    expect(rejected).toMatchObject({ ok: false, code: 'FILE_BATCH_SIZE_LIMIT' })
    expect(createId).not.toHaveBeenCalled()
    expect(accepted.selections.map(selection => selection.file)).toEqual([exact, empty])
  })

  test('removes by stable ID without mutating the input list', () => {
    const first = { fileId: 'file_1', file: createFile('a.bin', 2) }
    const second = { fileId: 'file_2', file: createFile('b.bin', 3) }
    const selections = [first, second]

    const next = removeFileSelection(selections, 'file_1')

    expect(next).toEqual([second])
    expect(next).not.toBe(selections)
    expect(selections).toEqual([first, second])
    expect(totalSelectionBytes(selections)).toBe(5)
  })
})
