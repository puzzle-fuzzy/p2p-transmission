# Interaction Feedback UX Design

## Goal

Improve the core transfer interactions so users can immediately understand what is clickable, which transfer mode is active, which recipients are selected, and whether received text was copied successfully. Preserve the existing dark, restrained visual system and keep the sender and receiver flows short.

## Considered Approaches

### 1. Enhance the existing controls in place (selected)

Keep the current `TransferPanel`, `RecipientPickerDialog`, and `ReceivedTextDialog` boundaries. Add a shared cursor rule for enabled interactive elements, turn the existing transfer tabs into a two-slot segmented control with an animated background slider, strengthen selected recipient rows, and make the existing copy state persistent and visible.

This is the smallest change that addresses all five UX concerns without changing transfer state, protocol behavior, or the component API more than necessary.

### 2. Extract new interaction primitives

Create reusable `SegmentedControl`, `Checkbox`, and `CopyButton` components and migrate the affected views to them.

This could improve future reuse, but it adds abstraction and migration surface for three interactions that currently have limited usage. It is deferred until a second consumer appears.

### 3. Use only local utility-class changes

Patch each affected button and row independently without a shared cursor rule or a common interaction vocabulary.

This is quick, but it makes it easy to miss future clickable controls and would leave the interface inconsistent. It is rejected as the primary approach.

## Scope

### Clickable affordances

- Enabled buttons, links, and enabled selectable labels use a hand cursor.
- Disabled controls retain a not-allowed cursor where applicable and never receive the enabled cursor rule.
- The lobby `关于 P2P Transmission` trigger is styled as a text link with an underline, underline offset, and a restrained hover change.
- Existing focus-visible, disabled, and loading behavior remains intact.

### Transfer mode tabs

- The tab list becomes a two-column segmented control with equal-width options.
- A single background slider sits behind the labels and translates between the text and file positions over a short transition.
- The active label remains visually stronger; inactive labels retain a hover response.
- Existing `role="tablist"`, `role="tab"`, `aria-selected`, roving `tabIndex`, and Arrow/Home/End keyboard behavior remain unchanged.
- The slider is decorative and hidden from assistive technology.
- Reduced-motion users receive the same selected state without animated translation.

### Recipient picker

- Each recipient option keeps native checkbox semantics and adds a visible custom checkbox surface.
- Selected rows use a low-opacity accent background and accent border, in addition to the check mark.
- Unselected rows remain neutral and distinguishable from hover state.
- Keyboard focus continues to be visible through the row, not only through the visually hidden native input.
- The dialog continues to support multi-select, select all, clear all, Escape, and confirmation without changing selection semantics.

### Received text copy feedback

- The copy button shows a state-specific icon and label for idle, copying, copied, and error states.
- The copied state uses the existing accent color vocabulary and remains until the dialog closes or a different text item becomes current.
- A stable status line below the action communicates `文本已复制到剪贴板` or a recoverable error without causing layout jumps.
- The status remains available through a polite live region; color and icon are supplementary rather than the only signal.
- Copying remains disabled only while the clipboard operation is pending, so users can retry after success or failure.

## Interaction and motion

- Use the existing white-opacity surfaces and purple accent; do not introduce gradients, shadows, or a new color palette.
- Use short, purposeful transitions for the tab slider and selection surfaces.
- No flashing success animation is added. Persistence and contrast carry the feedback.
- Honor `prefers-reduced-motion` by removing the slider transition while retaining the final position.
- Keep all changed controls at or above the existing 44px touch target convention.

## Accessibility

- Preserve semantic buttons, links, labels, tabs, and checkbox inputs rather than replacing them with click-only containers.
- Keep the tab keyboard interaction and active-tab announcement unchanged.
- Keep selected recipient state exposed through the native checkbox `checked` property and visible in the row.
- Expose copy status with a polite live region and a stable visible message.
- Ensure focus-visible styles remain present for every changed control.
- Decorative slider and icons are `aria-hidden`.

## Testing

- `TransferPanel`: active slider position for text/file, tab keyboard switching, and clickable affordance classes/behavior.
- `RecipientPickerDialog`: selected row data/state, visible selected checkbox treatment, multi-select, clear/select-all, and keyboard confirmation behavior.
- `ReceivedTextDialog`: idle/copying/copied/error labels and icons, persistent copied status message, retry availability, and live status text.
- Existing focused tests and the repository `verify` script must pass.
- Check the built frontend for type errors and production build regressions.

## Non-goals

- No change to WebRTC signaling, transfer protocol, clipboard API, room membership, or recipient selection data flow.
- No new component library, design token system, animation framework, or visual theme.
- No automatic timeout that hides copy success.
- No redesign of the transfer layout beyond the tab, recipient selection, and copy feedback states described above.
