export type PasteCandidate =
  | { kind: 'files'; files: readonly File[] }
  | { kind: 'text'; text: string }

export const readPasteCandidate = (
  data: DataTransfer,
): PasteCandidate | undefined => {
  const files = Array.from(data.files)
  if (files.length > 0) return { kind: 'files', files }

  const text = data.getData('text/plain')
  return text.length > 0 ? { kind: 'text', text } : undefined
}

export const createPastedTextFile = (
  text: string,
  existingNames: readonly string[],
  now = Date.now(),
): File => {
  const occupied = new Set(existingNames.map(name => name.toLocaleLowerCase()))
  let name = '粘贴内容.txt'
  let suffix = 2
  while (occupied.has(name.toLocaleLowerCase())) {
    name = `粘贴内容 (${String(suffix)}).txt`
    suffix += 1
  }

  return new File([text], name, {
    type: 'text/plain',
    lastModified: now,
  })
}
