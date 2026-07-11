# Room Code Copy Button Design

## Goal

Reduce the room-code copy control's visual weight while preserving its 44 px touch target, copy behavior, duplicate-click protection, and accessible feedback.

## Considered Approaches

1. **Static copy icon with hover/focus background (selected).** Remove the border, use a circular hit area, and keep `content_copy` visible for every state. This best matches the control's secondary importance.
2. **Static icon with a persistent success background.** This gives stronger confirmation but competes with the existing Toast and adds unnecessary visual state.
3. **State-changing icons without a border.** This retains the spinner/check/error behavior, but conflicts with the requirement that the control use one icon only.

## Selected Visual Design

- Keep the existing `min-h-11 min-w-11` target so mouse, keyboard, and touch interaction remain comfortable.
- Replace `rounded-lg` with `rounded-full`.
- Remove all border classes.
- Keep the icon at 17 px and always render `content_copy`.
- Use a subtle background and brighter icon on hover and keyboard focus.
- Do not add a ring, shadow, or persistent filled state.
- During an in-flight copy, keep the same icon, disable duplicate clicks, and reduce its emphasis using the existing disabled treatment.

## Feedback and Accessibility

- Preserve the stable accessible name `复制房间码`.
- Preserve `data-status` for tests and state inspection.
- Preserve the `aria-live` announcements for copying, success, and failure.
- Continue using the existing Toast for visible success or failure feedback.
- Keyboard focus remains visible through the same circular background change and brighter icon used for hover.

## Scope

Only `RoomCodeCopyButton.tsx` and its component tests change. Room layout, clipboard behavior, Toast behavior, and other icon buttons remain unchanged.

## Verification

- Component tests verify the exact copied code and success/error announcements.
- Styling tests verify a circular, borderless target with hover/focus background classes.
- Tests verify the icon remains `content_copy` while copying and after success or failure.
- Run Web tests, typecheck, lint, and a browser visual check at the existing room header.
