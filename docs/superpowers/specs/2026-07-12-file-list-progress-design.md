# Unified File List and Receiving Progress Design

## Goal

Make file rows visually stable before and after sending, and show receiving progress inside each file row using the same background-fill treatment as the sender.

## Considered Approaches

1. **Shared file-row component with per-file progress (selected).** Sender selection, sender transfer, receiver consent, and receiver transfer all use one visual primitive. This prevents future style drift and matches the real per-file progress events.
2. **Duplicate the sender styles in the receiver dialog.** This is a smaller initial edit, but keeps two implementations that can diverge again.
3. **Apply one batch percentage to every receiver row.** This removes the standalone bar but misrepresents files that start or finish at different times.

## Shared File Row

Create a reusable file-row component that accepts:

- stable file ID, name, and byte length;
- normalized progress from `0` to `1`;
- visual state: queued, transferring, completed, or error;
- optional trailing action, such as removing a selected file.

Every row uses the sender's current transfer appearance:

- rounded `bg-white/5` surface;
- document icon, truncated file name, formatted size, and right-aligned state text;
- an absolutely positioned `bg-accent/15` layer that fills from left to right;
- content rendered above the fill layer;
- a short `motion-safe` width transition that becomes instant when reduced motion is requested.

The shared component owns progress clamping, state labels, byte formatting, and progressbar accessibility so the sender and receiver cannot interpret the same state differently.

## Sender Behavior

Before sending, each selected file renders through the shared row with zero progress and the queued label. The existing remove action remains available; this is the only intentional row-level difference before transfer.

After sending starts, the same row structure remains mounted and receives the existing per-file progress and state. File editing and picker actions are disabled, but the list itself must not receive reduced opacity because that weakens the progress visualization.

The list geometry, filename, size, background, and state column therefore remain stable when the user clicks Send.

## Receiver Behavior

Before consent, each requested file renders through the same shared row with zero progress.

After acceptance:

- initialize a normalized progress entry for every file;
- use `fileBytes / fileTotalBytes` from each receiving progress event;
- update only the matching file ID;
- never move a file backward when coalesced or delayed events arrive;
- treat a zero-byte file as complete for visual progress;
- render the file percentage or completed state in the row;
- remove the standalone batch progress label and bar beneath the list.

When all files arrive, the existing received/download state remains responsible for Blob URLs and Save actions. Transfer protocol, consent, receipts, and download behavior do not change.

## State and Data Flow

The receiving dialog state changes from one batch percentage to a `progressByFileId` record containing normalized values. `App` initializes that record on acceptance and updates it through the existing animation-frame progress scheduler.

Only events matching the current peer, transfer ID, receiving direction, and known file ID may update the record. Room reset, reconnect, rejection, failure, and completion continue to replace or clear the whole incoming-file state as they do today.

## Accessibility

- Each transferring file row exposes its own progressbar named with the file name.
- `aria-valuenow` uses an integer percentage from 0 to 100.
- State text remains visible and does not rely on color alone.
- Pending consent still focuses Reject first and keeps Accept/Reject semantics unchanged.
- The shared row remains readable when motion reduction disables width transitions.

## Scope

This change covers the shared file-row presentation, `TransferPanel`, `IncomingFileRequestDialog`, incoming file progress state in `App`, and their tests. It does not change the transfer wire protocol, chunk engine, limits, consent rules, or completed-file URL lifecycle.

The previously approved room-code copy-button design is implemented in the same delivery but remains specified separately.

## Verification

- Shared-row tests cover queued, transferring, completed, error, clamping, labels, and optional actions.
- Sender tests compare the same row before and after Send and verify picker controls lock without dimming progress.
- Receiver dialog tests cover two files at different percentages and assert no standalone batch bar exists.
- App tests verify independent, monotonic per-file updates through the frame scheduler and cleanup on reset.
- Web tests, typecheck, lint, build, and browser visual checks must pass before delivery.
