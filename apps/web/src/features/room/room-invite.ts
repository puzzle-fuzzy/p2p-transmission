const ROOM_CODE_PATTERN = /^[0-9]{6}$/u

export const parseRoomCodeFromSearch = (search: string): string | undefined => {
  const values = new URLSearchParams(search).getAll('room')
  if (values.length !== 1) return undefined

  const [value] = values
  return value && ROOM_CODE_PATTERN.test(value) ? value : undefined
}
