import {
  parseLegacyRoomCode,
  parseRoomInviteFragment,
  type RoomInviteFragmentResult,
} from './room-invite'

export type RoomNavigationSnapshot = Readonly<{
  fragment: RoomInviteFragmentResult
  legacyRoomCode?: string
}>

export const consumeRoomNavigation = (
  target: Pick<Window, 'location' | 'history'>,
): RoomNavigationSnapshot => {
  const fragment = parseRoomInviteFragment(target.location.hash)
  const legacyRoomCode = parseLegacyRoomCode(target.location.search)

  if (fragment.kind !== 'absent') {
    target.history.replaceState(
      target.history.state,
      '',
      `${target.location.pathname}${target.location.search}`,
    )
  }

  return Object.freeze({
    fragment,
    ...(legacyRoomCode ? { legacyRoomCode } : {}),
  })
}
