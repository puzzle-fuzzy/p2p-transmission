import {
  MAX_FILE_BATCH_BYTES,
  MAX_FILE_COUNT,
} from '@p2p/contracts'

export type FileSelection = {
  fileId: string
  file: File
}

export type FileSelectionResult =
  | { ok: true; selections: FileSelection[] }
  | {
      ok: false
      code: 'FILE_COUNT_LIMIT' | 'FILE_BATCH_SIZE_LIMIT' | 'DUPLICATE_FILE'
      message: string
    }

export const totalSelectionBytes = (
  selections: readonly FileSelection[],
) => selections.reduce((total, selection) => total + selection.file.size, 0)

export const addFileSelections = (
  selections: readonly FileSelection[],
  files: readonly File[],
  createId: () => string,
): FileSelectionResult => {
  if (selections.length + files.length > MAX_FILE_COUNT) {
    return {
      ok: false,
      code: 'FILE_COUNT_LIMIT',
      message: `每批最多选择 ${String(MAX_FILE_COUNT)} 个文件`,
    }
  }

  const selectedFiles = new Set(selections.map(selection => selection.file))
  for (const file of files) {
    if (selectedFiles.has(file)) {
      return {
        ok: false,
        code: 'DUPLICATE_FILE',
        message: '不能重复添加同一个文件',
      }
    }
    selectedFiles.add(file)
  }

  const incomingBytes = files.reduce((total, file) => total + file.size, 0)
  if (totalSelectionBytes(selections) + incomingBytes > MAX_FILE_BATCH_BYTES) {
    return {
      ok: false,
      code: 'FILE_BATCH_SIZE_LIMIT',
      message: '文件总大小不能超过 500 MiB',
    }
  }

  return {
    ok: true,
    selections: [
      ...selections,
      ...files.map(file => ({ fileId: createId(), file })),
    ],
  }
}

export const removeFileSelection = (
  selections: readonly FileSelection[],
  fileId: string,
) => selections.filter(selection => selection.fileId !== fileId)
