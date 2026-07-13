# Release Stabilization Design

**Date:** 2026-07-13  
**Status:** Approved approach, pending written-spec review  
**Scope:** Restore the current browser transfer product to a buildable, testable, internally consistent release candidate without redesigning its room authorization protocol.

## 1. Goal

Stabilize the features currently on `main` so the application opens reliably, the documented transfer limits match the implemented protocol, sharing and receiver recovery complete their user journeys, transfer speed data is internally consistent, and every workspace passes the repository-level verification command.

The result must preserve the product principles in `PRODUCT.md`: no account requirement, a short create/join-to-transfer path, transparent status, and understandable recovery. It must preserve the flat “Dark Workshop” visual direction in `DESIGN.md`.

## 2. Confirmed Scope

This stabilization includes:

1. Fix the first-render temporal-dead-zone crash in `App.tsx`.
2. Fix every TypeScript, unit-test, lint-warning, and production-build regression currently reproduced by `bun run verify`.
3. Restore the confirmed transfer limits to at most 10 files and 100 MiB per batch across contracts, UI copy, validation, tests, and documentation.
4. Make `/?room=123456` sharing links and QR codes prefill the six-digit room code while preserving an explicit user confirmation before joining.
5. Make share/copy feedback reflect the actual asynchronous clipboard result.
6. Make receiver room recovery survive the transition into a realtime connection and avoid the current callback-order crash.
7. Keep sender recovery explicitly unsupported in this release rather than persisting unusable sender state.
8. Make speed and ETA tracking type-safe and isolate samples by direction, transfer, peer, and file so multiple receivers cannot corrupt one another’s samples.
9. Replace the absolute privacy claim with accurate WebRTC, relay, server-storage, and browser-memory wording.
10. Restore the circular per-file download hit area expected by the established UI and update Tailwind v4 test expectations where the implementation is already correct.
11. Add a CI verification workflow pinned to the repository’s declared Bun version.

## 3. Explicitly Deferred

The following remain release blockers for a public security launch, but they are a separate protocol and authorization milestone:

- high-entropy invitation tokens;
- sender approval, room locking, and receiver removal;
- removal or membership protection of the public room lookup endpoint;
- WebSocket signaling rate, frame-size, and queue limits;
- application-layer authenticated encryption;
- streaming-to-disk, resumable transfer, file digests, Redis, and multi-instance signaling;
- notification permission redesign and service-worker cache hardening.

This separation keeps the stabilization patch reviewable. It does not classify the deferred security work as optional before public release.

## 4. Chosen Approach

Use a focused stabilization slice rather than either of the rejected extremes:

- A compile-only patch was rejected because it would leave newly advertised sharing, recovery, and 50-file behavior broken.
- A combined authorization redesign was rejected because it changes HTTP contracts, room membership, WebRTC topology, and visible product decisions in the same patch.

The chosen approach keeps existing component boundaries and introduces only small pure helpers where they make behavior independently testable. `App.tsx` will not be broadly refactored in this milestone.

## 5. Architecture and Components

### 5.1 Room invite parsing

Add a small room-invite helper under `apps/web/src/features/room/` with a pure function:

```ts
parseRoomCodeFromSearch(search: string): string | undefined
```

It accepts only exactly six ASCII digits from the `room` query parameter. Missing, duplicate, empty, short, long, or non-numeric values produce `undefined`.

`App` reads the current search string and passes the valid value to `RoomJoin`. `RoomJoin` initializes its six controlled inputs from this value. The primary action remains “加入房间”; loading a link never joins automatically.

### 5.2 Receiver session recovery

The recovery effect must be declared after the stable `handleJoinRoom` callback so React never evaluates a block-scoped callback before initialization.

Only receiver sessions are persisted in this milestone. A successful normal or recovered join stores the receiver room after runtime connection initialization has disposed the previous room resources. Sender room creation does not write a recoverable room entry because the current HTTP bootstrap flow cannot safely reconstruct sender ICE state after reload.

Recovery rules:

- expired saved sessions are removed and reported once;
- a valid receiver session triggers one join attempt per application boot;
- the saved entry is not deleted before the attempt;
- successful join replaces it with the fresh room expiry;
- an explicit leave, terminal room failure, or room expiry removes it;
- a failed recovery remains recoverable on the next page load and shows the normal join error in the current load.

### 5.3 Speed and ETA tracking

Each speed sample is keyed by a stable compound string derived from:

```text
direction + transferId + peerId + fileId
```

Samples store timestamp, completed bytes, and total bytes. `record` owns the total-byte value and `getEta` therefore takes only the compound key, matching the public `SpeedTracker` interface.

Incoming transfers display the current sender/file sample. For outgoing multi-receiver transfers, the file row displays the slowest active receiver’s positive speed and the largest finite ETA, matching the existing “progress follows the slowest accepted receiver” presentation. Terminal and room-reset paths clear the tracker and UI data.

### 5.4 Clipboard and native sharing

`ShareDialog.onCopy` becomes asynchronous. The dialog changes to “已复制” only after the promise resolves. A rejected copy preserves the previous label and relies on the existing toast for the recovery message.

Native sharing is feature-detected through an optional callable obtained from `navigator`, rather than by testing the truthiness of a DOM-lib-required method. Cancelling the native share does not falsely report a copied link. When native sharing is unavailable, the fallback awaits copying the complete room URL.

Room-code and room-link success messages are distinct.

### 5.5 Transfer constraints

The single sources of truth return to:

```ts
MAX_FILE_COUNT = 10
MAX_FILE_BATCH_BYTES = 100 * 1024 * 1024
```

The UI and documentation derive or state the same values. Tests cover exactly 10 files, reject 11, accept exactly 100 MiB, and reject one byte over. The 16 KiB control-frame bound remains unchanged and is compatible with ten maximum-length descriptors.

### 5.6 Privacy copy

The lobby statement becomes:

> 文件和文本正文通过加密的 WebRTC 通道传输，优先尝试设备直连，必要时经加密中继转发；应用服务器只协调连接，不保存传输内容。接收完成的文件会暂存在当前页面中，关闭结果或退出房间后释放。

This text avoids claiming independently authenticated E2EE, guaranteed direct routing, or immediate memory release at transfer completion.

### 5.7 Verification workflow

Add a GitHub Actions workflow that:

1. checks out the repository;
2. installs Bun `1.3.14`, matching `packageManager`;
3. runs `bun install --frozen-lockfile`;
4. runs `bun run verify`.

The workflow runs for pull requests and pushes to `main`. No deployment occurs in this milestone.

## 6. Error Handling

- Invalid or absent share parameters fall back to an empty join form without a toast.
- Clipboard rejection never reports success and keeps the dialog open.
- Receiver recovery errors use the same user-friendly API error mapping as a manual join.
- Speed tracking ignores non-finite, negative, duplicate, or regressing byte samples and never renders non-finite ETA values.
- File-limit errors remain controlled selection errors and never start a transfer.
- CI failure blocks merge but does not mutate artifacts or deploy services.

## 7. Testing Strategy

Implementation follows focused test-first changes:

1. Add pure invite-parser tests for valid, missing, duplicate, malformed, and encoded query values.
2. Extend `RoomJoin` tests for prefilled digits and explicit confirmation.
3. Update App integration tests for first mount, receiver recovery, persistence ordering, invalid share URLs, and successful deep-link join intent.
4. Add speed-tracker tests using an injected clock, including throttling, ETA, reset, and isolated compound keys.
5. Add multi-receiver App/UI-state coverage proving one peer cannot regress another peer’s speed sample.
6. Update ShareDialog tests for native share, fallback copy, copy rejection, and cancellation.
7. Restore contract and selection boundary tests to 10 files and 100 MiB.
8. Restore the circular download control assertion and update Tailwind v4 important-modifier assertions.
9. Run focused tests after each unit, then run `bun run verify` from the repository root.

## 8. Acceptance Criteria

The stabilization is complete only when all of the following are true:

- the app mounts without an uncaught exception in StrictMode;
- `bun run verify` exits successfully with no lint warnings;
- a valid shared URL prefills all six room-code digits and waits for a click;
- invalid shared URLs leave the join form empty;
- copy/share UI never reports success before success occurs;
- a receiver room entry survives realtime initialization and supports one recovery attempt after refresh;
- no sender room entry claims unsupported recovery;
- file selection and protocol boundaries are uniformly 10 files and 100 MiB;
- incoming and outgoing speed/ETA values are finite and isolated across peers;
- the privacy statement matches actual routing, storage, and lifetime behavior;
- the existing local `TransferPanel` clear-button and “暂无接收者连接” work remains intact;
- only the intended stabilization files and the pre-existing local `TransferPanel` changes remain in the worktree before final integration decisions.

