# Peer Flow and Batch Receive UX Design

## Goal

Improve the sender connection header, room-code copying, file-list density, and receiver consent flow while preserving the existing reliable whole-batch file protocol.

The result should remain fast, minimal, and explicit:

- connected avatars represent peers whose WebRTC channel is actually ready;
- the connector is static until bytes are being transferred;
- the room code and copy icon form one clear copy target;
- long file selections scroll inside a bounded list;
- receiver consent remains whole-batch, with a larger primary action and a useful cancellation path;
- completed files remain individually downloadable without pretending the browser can guarantee automatic multi-file downloads.

## Considered Approaches

### 1. Preserve protocol v2 and improve the batch UX (selected)

Keep the current whole-batch accept or reject decision. Improve the interface and expose individual download links only after the accepted batch has arrived.

This is the smallest reliable design. It does not waste implementation effort on a withdrawn selective-transfer requirement, does not mislabel consent as a completed download, and keeps the existing file validation, receipt, timeout, and Blob URL lifecycle intact.

### 2. Add protocol v3 subset acceptance

Let the receiver return an accepted file-ID subset and send only those files. This would require a protocol version change, per-peer selected file sets, sender progress semantics for skipped files, new parser validation, and coordinated compatibility handling.

This is intentionally out of scope because the selective-transfer request was withdrawn.

### 3. Accept the batch and automatically click multiple download links

Receive everything, then invoke several browser downloads programmatically. This is rejected because browser download settings may ask for permission or block later automatic downloads, and the application cannot determine that every file was saved successfully.

## Connected Peer Identity

The current room state stores only `readyPeerCount`, so it cannot reliably choose which receiver avatars to show when only part of the room has a ready P2P channel.

The ready peers become identity-based:

- `PeerSession` replaces the count-only `readyPeerCount()` query with `readyPeerIds()`;
- `RoomFlowState` replaces its stored count with a normalized, unique `readyPeerIds` list;
- the room flow action carries peer IDs rather than an independent count;
- the room phase and visible connection count derive from that list length;
- realtime disconnect, visitor reset, room creation, room join, and lobby return clear the list;
- `App` maps those IDs back to current room participants before passing receivers to `TransferPanel`.

This keeps the count and avatars from diverging. During an active transfer, the flow shows only ready receivers included in the activity peer IDs. A receiver that connects after the offer may appear in the connected count but does not appear as a recipient of the in-flight transfer.

## Sender Header and Peer Flow

`TransferPanel` removes the duplicated room code and the separate activity flow card. Its top row contains:

- the text/file tabs on the left;
- the connection label and `TransferPeerFlow` on the right.

The flow is always mounted and uses these states:

1. No ready receivers: render only the sender avatar.
2. One or more ready receivers while idle, requesting consent, complete, or error: render sender avatar, a short neutral straight line, and receiver avatars.
3. Transferring: replace the straight line with three accent dots using the existing restrained wave motion.

Only `transferring` is animated. Waiting for a decision is not byte transfer and therefore remains static. Reduced-motion mode renders stable dots with no wave animation.

Show at most three receiver avatars plus a `+n` overflow indicator. This keeps the status group usable on compact screens. The connection label and peer flow always remain on one horizontal line, with the flow to the label's right. On compact screens the complete status group sits below the tabs; from `sm` upward it shares the same row with the tabs.

The flow remains one polite live status. Its visual avatar subtree stays hidden from assistive technology, while the accessible label describes waiting, connected, requesting, transferring, complete, and error states.

## Room-Code Copy Target

`RoomCodeCopyButton` becomes the complete room-code control instead of an icon-only button beside a non-interactive number.

- The room code uses the existing mono typography.
- The copy icon remains the single `content_copy` icon in idle, copying, success, and error states.
- The full code-plus-icon area is one button, so clicking either part invokes the same copy operation exactly once.
- The icon keeps a circular secondary hover/focus surface.
- The control remains borderless, at least 44 px high, keyboard accessible, and backed by the existing Toast and polite live announcement.

`App` no longer renders a separate room-code text node beside the component.

## Sender File List

When files are selected, the drop zone is split into a bounded file list and a stable footer action:

- the list uses `native-scrollbar`, `overflow-y-auto`, `overscroll-contain`, and a maximum height of 13 rem on compact screens and 14 rem from `sm` upward;
- `添加更多文件` remains outside the scrolling region, so it is always reachable;
- the 10-file and 100 MiB limits remain unchanged;
- dragging, choosing, removing, locking, sending, and cancellation behavior remain unchanged.

`FileTransferRow` positions its optional trailing action without allowing a 44 px remove or download target to increase row height. Selected and transferring rows therefore retain the same geometry as well as the same visual surface.

## Receiver Batch Flow

The protocol remains one decision for the complete request.

### Pending

- Every requested file renders through `FileTransferRow` at zero progress.
- The footer uses a one-third secondary `拒绝` action and a two-thirds primary `接收全部` action.
- Reject keeps its existing exact-once behavior and closes the request.
- Accept sends the existing whole-batch decision and initializes per-file progress.

### Receiving

- The file rows continue to show independent background progress.
- The disabled Reject and Accept buttons are removed.
- A single full-width secondary `取消接收` action calls the existing transfer cancellation capability, closes the dialog, resets the receiver panel, and informs the sender through the current cancel frame.

### Received

- The dialog does not switch to a second, differently styled file list.
- The same rows become completed at 100%.
- Each row receives a 44 px circular download action with an accessible name such as `下载 设计稿.png`.
- Downloads continue to use the existing Blob URLs and native `download` attribute.
- A full-width `关闭` action dismisses the dialog.
- Downloading a file does not immediately revoke its URL, so the user can retry. Close, reset, reconnect, and unmount keep the existing exact-once URL cleanup.

### Error

- File rows remain in the explicit failed state.
- The current recoverable error message and Close action remain.
- Cancellation is not presented as an error.

## Browser Download Boundary

The application does not label the consent action `一键下载` because no file Blob exists at consent time. It also does not trigger a series of automatic downloads after the asynchronous transfer finishes.

The UI promises only what it can verify:

- `接收全部` means the full request was accepted for P2P transfer;
- `下载 文件名` starts the browser download for that completed Blob;
- the app never claims a file was saved, because browser settings determine whether a prompt appears and where the file is written.

ZIP generation, directory-picker integration, selective transfer, and automatic multi-file download are out of scope.

## Accessibility and Responsive Behavior

- All interactive targets remain at least 44 by 44 px.
- The full room-code control has one stable accessible name.
- The file list remains a semantic list and each progress row exposes its named progressbar.
- Download actions include the file name in their accessible label.
- The connector animation respects reduced motion.
- Long filenames remain truncated with their complete value in `title`.
- The connected status group must not overflow a 320 px viewport.

## Error Handling and Lifecycle

- Clipboard success and failure continue to use the existing Toast and live-region flow.
- Ready peer IDs are cleared whenever the peer session is disposed or room connectivity resets.
- Receiver cancellation is exact-once and ignores stale or mismatched requests.
- File progress remains monotonic and keyed by the active peer, transfer, and file ID.
- Blob URL creation remains transactional; partial URL creation is rolled back on failure.
- Blob URLs are revoked exactly once on close, reset, reconnect, or unmount.
- No file protocol limits, validation, chunking, receipts, TURN behavior, or timeout constants change.

## Verification

- `TransferPeerFlow` tests cover sender-only, static line, transferring dots, overflow, accessible state, and reduced animation triggers.
- room-state and peer-session tests cover exact ready peer IDs, deduplication, disconnect cleanup, and count derivation.
- `TransferPanel` tests cover removal of the duplicate room code, persistent header flow, active recipient filtering, bounded scrolling, and stable row geometry.
- room-code tests verify that both the visible number area and icon belong to one button and copy exactly once in all status states.
- receiver dialog tests cover the one-to-two action ratio, exact-once accept/reject/cancel, no disabled decision buttons while receiving, completed shared rows, and named download links.
- `App` tests cover ready receiver mapping, receiver cancellation, Blob URL ownership, and cleanup.
- Web tests, typecheck, lint, production build, repository verification, and in-browser visual checks must pass before delivery.
