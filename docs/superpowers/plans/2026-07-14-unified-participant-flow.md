# Unified Participant Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the sender/receiver-specific avatar treatments with one sender-left, receivers-right connection flow that supports five avatar slots and distinct connecting, connected, transferring, complete, and error visuals.

**Architecture:** Keep `TransferPeerFlow` as the single presentation component and make its phase explicit. `TransferPanel` and `ReceiverPanel` only map their existing business state into that interface; `App` passes receiver-side peer readiness so the receiver panel can distinguish “member known” from “WebRTC ready.” No API, contract, session, or transfer-protocol changes are required.

**Tech Stack:** React 19, TypeScript 6, Tailwind CSS 4, Vitest + Testing Library, Vite 8, Bun 1.3.14.

## Global Constraints

- Preserve the existing dark, flat visual system: no shadows, gradients, glass effects, new colors, or new icon libraries.
- The sender is always on the left and the receiver group is always on the right, regardless of the current device role.
- Show every receiver through five people; above five, show four avatars and a fifth circular badge containing the total receiver count.
- Use transform/opacity for waiting dots and SVG dash offset for transfer motion; honor `prefers-reduced-motion`.
- Preserve sender-side recipient selection and receiver-side read-only behavior.
- Use Python scripts for terminal inspection and verification output to avoid PowerShell encoding problems.
- Preserve unrelated user changes and do not stage or commit files outside the task.

---

## File Map

- `apps/web/src/components/TransferPeerFlow.tsx`: the shared visual contract, avatar-slot rules, state track, and optional recipient-picker trigger.
- `apps/web/src/index.css`: waiting-dot and transfer-dash animation definitions plus reduced-motion fallback.
- `apps/web/src/components/TransferPeerFlow.test.tsx`: direct coverage of avatar limits, orientation, phase visuals, and keyboard interaction.
- `apps/web/src/components/TransferPanel.tsx`: sender-side phase mapping and placement of the shared flow.
- `apps/web/src/components/TransferPanel.test.tsx`: sender-side integration, active-recipient filtering, and empty waiting state.
- `apps/web/src/components/ReceiverPanel.tsx`: receiver-side phase mapping and removal of the duplicate local identity row.
- `apps/web/src/components/ReceiverPanel.test.tsx`: receiver-side integration and duplicate-avatar regression coverage.
- `apps/web/src/App.tsx`: pass sender peer readiness into `ReceiverPanel`.
- `apps/web/src/App.test.tsx`: verify the receiver panel receives the ready state.

### Task 1: Build the shared avatar flow and motion language

**Files:**
- Modify: `apps/web/src/components/TransferPeerFlow.test.tsx:17-141`
- Modify: `apps/web/src/components/TransferPeerFlow.tsx:1-104`
- Modify: `apps/web/src/index.css:30-43,91-106,159-171`

**Interfaces:**
- Consumes: `PublicVisitor`, an optional `sender`, `receivers`, `TransferPeerFlowPhase`, an accessible status label, and the existing optional picker callback/ref.
- Produces: `TransferPeerFlowPhase = 'connecting' | 'idle' | 'requesting' | 'transferring' | 'complete' | 'error'` and stable DOM hooks for phase, sender side, receiver side, placeholder, dots, line, dash, and state icon.

- [ ] **Step 1: Replace the component tests with the unified visual contract**

Use the existing `createVisitor` helper and replace the current cases with these exact assertions:

```tsx
test('keeps the sender left and uses five receiver slots with total-count overflow', () => {
  const sender = createVisitor('sender', 'Sender')
  const receivers = Array.from({ length: 6 }, (_, index) =>
    createVisitor(`receiver-${index + 1}`, `Receiver ${index + 1}`))

  render(
    <TransferPeerFlow
      sender={sender}
      receivers={receivers}
      phase="idle"
      accessibleLabel="6 receivers connected"
    />,
  )

  const status = screen.getByRole('status', { name: '6 receivers connected' })
  const senderSide = status.querySelector('[data-side="sender"]')
  const receiverSide = status.querySelector('[data-side="receivers"]')
  expect(senderSide).not.toBeNull()
  expect(receiverSide).not.toBeNull()
  expect(senderSide!.compareDocumentPosition(receiverSide!) & Node.DOCUMENT_POSITION_FOLLOWING)
    .toBeTruthy()
  expect(screen.getByTitle('Sender')).not.toBeNull()
  expect(screen.getByTitle('Receiver 1')).not.toBeNull()
  expect(screen.getByTitle('Receiver 4')).not.toBeNull()
  expect(screen.queryByTitle('Receiver 5')).toBeNull()
  expect(screen.queryByTitle('Receiver 6')).toBeNull()
  expect(screen.getByTitle('共 6 位接收者').textContent).toBe('6')
})

test('shows all five receivers before switching to the total-count badge', () => {
  const sender = createVisitor('sender', 'Sender')
  const receivers = Array.from({ length: 5 }, (_, index) =>
    createVisitor(`receiver-${index + 1}`, `Receiver ${index + 1}`))

  render(
    <TransferPeerFlow
      sender={sender}
      receivers={receivers}
      phase="idle"
      accessibleLabel="5 receivers connected"
    />,
  )

  expect(screen.getByTitle('Receiver 5')).not.toBeNull()
  expect(screen.queryByTitle('共 5 位接收者')).toBeNull()
})

test('maps connection phases to dots, a line, moving dashes, and state icons', () => {
  const sender = createVisitor('sender', 'Sender')
  const receiver = createVisitor('receiver', 'Receiver')
  const props = { sender, receivers: [receiver], accessibleLabel: 'Peer state' }
  const { rerender } = render(<TransferPeerFlow {...props} phase="connecting" />)
  const status = screen.getByRole('status')

  expect(status.querySelectorAll('.transfer-peer-flow__dot')).toHaveLength(3)
  expect(status.querySelector('.transfer-peer-flow__line')).toBeNull()

  rerender(<TransferPeerFlow {...props} phase="idle" />)
  expect(status.querySelector('.transfer-peer-flow__line')).not.toBeNull()
  expect(status.querySelector('.transfer-peer-flow__dash')).toBeNull()

  rerender(<TransferPeerFlow {...props} phase="requesting" />)
  expect(status.querySelectorAll('.transfer-peer-flow__dot')).toHaveLength(3)

  rerender(<TransferPeerFlow {...props} phase="transferring" />)
  expect(status.querySelector('.transfer-peer-flow__dash')).not.toBeNull()
  expect(status.querySelectorAll('.transfer-peer-flow__dot')).toHaveLength(0)

  rerender(<TransferPeerFlow {...props} phase="complete" />)
  expect(status.querySelector('[data-state-icon="check"]')).not.toBeNull()

  rerender(<TransferPeerFlow {...props} phase="error" />)
  expect(status.querySelector('[data-state-icon="link_off"]')).not.toBeNull()
})

test('shows a receiver placeholder while connecting with nobody ready', () => {
  const sender = createVisitor('sender', 'Sender')
  render(
    <TransferPeerFlow
      sender={sender}
      receivers={[]}
      phase="connecting"
      accessibleLabel="Waiting for receivers"
    />,
  )

  const status = screen.getByRole('status')
  expect(status.querySelector('.transfer-peer-flow__placeholder')).not.toBeNull()
  expect(status.querySelectorAll('.transfer-peer-flow__dot')).toHaveLength(3)
})

test('keeps the recipient picker keyboard-focusable and reports selection count', () => {
  const sender = createVisitor('sender', 'Sender')
  const receiver = createVisitor('receiver', 'Receiver')
  const onClick = vi.fn()
  render(
    <TransferPeerFlow
      sender={sender}
      receivers={[receiver]}
      phase="idle"
      accessibleLabel="Ready to send"
      onClick={onClick}
      selectedCount={1}
    />,
  )

  const trigger = screen.getByRole('button', { name: '选择接收者，已选择 1 位' })
  trigger.focus()
  expect(document.activeElement).toBe(trigger)
  trigger.click()
  expect(onClick).toHaveBeenCalledTimes(1)
})
```

- [ ] **Step 2: Run the focused test and confirm the old component fails the new contract**

Run:

```bash
bun run --cwd apps/web test -- TransferPeerFlow.test.tsx
```

Expected: FAIL because `connecting` is not yet a valid phase, six receivers currently render three avatars plus `+3`, and no placeholder/dash/state-icon hooks exist.

- [ ] **Step 3: Replace `TransferPeerFlow` with the unified implementation**

Implement the following structure; keep the existing imports and picker ref behavior:

```tsx
import type { Ref } from 'react'
import type { PublicVisitor } from '../shared/contracts'
import Avatar from './Avatar'

export type TransferPeerFlowPhase =
  | 'connecting'
  | 'idle'
  | 'requesting'
  | 'transferring'
  | 'complete'
  | 'error'

export type TransferPeerFlowProps = {
  sender?: PublicVisitor
  receivers: PublicVisitor[]
  phase: TransferPeerFlowPhase
  accessibleLabel: string
  onClick?(): void
  selectedCount?: number
  triggerRef?: Ref<HTMLButtonElement>
}

const MAX_AVATAR_SLOTS = 5
const VISIBLE_BEFORE_TOTAL = MAX_AVATAR_SLOTS - 1

const StateTrack = ({ phase }: { phase: TransferPeerFlowPhase }) => {
  if (phase === 'connecting' || phase === 'requesting') {
    return (
      <span className="flex items-center gap-1.5">
        <span className="transfer-peer-flow__dot size-1 rounded-full bg-accent" />
        <span className="transfer-peer-flow__dot size-1 rounded-full bg-accent" />
        <span className="transfer-peer-flow__dot size-1 rounded-full bg-accent" />
      </span>
    )
  }

  if (phase === 'transferring') {
    return (
      <svg
        className="transfer-peer-flow__dash h-2 w-full text-accent"
        viewBox="0 0 100 2"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <line
          className="transfer-peer-flow__dash-line"
          x1="0"
          y1="1"
          x2="100"
          y2="1"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeDasharray="7 7"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    )
  }

  if (phase === 'error') {
    return (
      <span className="flex w-full items-center gap-2 text-amber-50/35">
        <span className="transfer-peer-flow__line h-px flex-1 bg-current" />
        <span
          className="material-symbols-outlined"
          style={{ fontSize: '15px' }}
          data-state-icon="link_off"
        >
          link_off
        </span>
        <span className="transfer-peer-flow__line h-px flex-1 bg-current" />
      </span>
    )
  }

  return (
    <span className="flex w-full items-center gap-2 text-amber-50/25">
      <span className="transfer-peer-flow__line h-px flex-1 bg-current" />
      {phase === 'complete' && (
        <span
          className="material-symbols-outlined text-accent"
          style={{ fontSize: '15px' }}
          data-state-icon="check"
        >
          check
        </span>
      )}
    </span>
  )
}

export default function TransferPeerFlow({
  sender,
  receivers,
  phase,
  accessibleLabel,
  onClick,
  selectedCount,
  triggerRef,
}: TransferPeerFlowProps) {
  const overflow = receivers.length > MAX_AVATAR_SLOTS
  const visibleReceivers = overflow
    ? receivers.slice(0, VISIBLE_BEFORE_TOTAL)
    : receivers
  const animated = phase === 'connecting'
    || phase === 'requesting'
    || phase === 'transferring'

  const visualFlow = (
    <div className="flex w-full min-w-0 items-center" aria-hidden="true">
      <span className="flex size-9 shrink-0 items-center" data-side="sender">
        {sender && (
          <Avatar
            seed={sender.avatarSeed}
            label={sender.displayName}
            className="shrink-0 max-sm:size-8!"
          />
        )}
      </span>

      <span className="flex min-w-8 flex-1 items-center justify-center px-3 sm:px-5">
        <StateTrack phase={phase} />
      </span>

      <span className="flex min-w-9 shrink-0 items-center justify-end pl-2" data-side="receivers">
        {receivers.length === 0 ? (
          <span className="transfer-peer-flow__placeholder flex size-9 items-center justify-center rounded-full border border-amber-50/15 text-amber-50/35 max-sm:size-8!">
            <span className="material-symbols-outlined" style={{ fontSize: '17px' }}>
              person_add
            </span>
          </span>
        ) : (
          <>
            {visibleReceivers.map((receiver, index) => (
              <Avatar
                key={receiver.id}
                seed={receiver.avatarSeed}
                label={receiver.displayName}
                className={`shrink-0 max-sm:size-8! ${index === 0 ? '' : '-ml-2'}`}
              />
            ))}
            {overflow && (
              <span
                className="-ml-2 flex size-9 shrink-0 items-center justify-center rounded-full border-2 border-surface bg-white/10 px-1 text-[11px] tabular-nums text-amber-50/70 max-sm:size-8!"
                title={`共 ${String(receivers.length)} 位接收者`}
              >
                {receivers.length}
              </span>
            )}
          </>
        )}
      </span>
    </div>
  )

  return (
    <div
      className="transfer-peer-flow w-full min-w-0"
      data-active={animated ? 'true' : 'false'}
      data-phase={phase}
      role="status"
      aria-label={accessibleLabel}
      aria-live="polite"
      aria-atomic="true"
    >
      {onClick ? (
        <button
          type="button"
          ref={triggerRef}
          className="min-h-11 w-full rounded-lg border border-transparent text-left transition-colors hover:bg-white/5 focus-visible:border-accent focus-visible:outline-none"
          onClick={onClick}
          aria-label={`选择接收者，已选择 ${String(selectedCount ?? receivers.length)} 位`}
          title="选择接收者"
        >
          {visualFlow}
        </button>
      ) : visualFlow}
    </div>
  )
}
```

- [ ] **Step 4: Add transfer-dash motion and scope waiting dots to waiting phases**

Add the following CSS next to `dot-wave`, replace the current `data-active` dot selectors, and extend reduced motion:

```css
@keyframes transfer-dash-flow {
  to {
    stroke-dashoffset: -28;
  }
}

.transfer-peer-flow[data-phase="connecting"] .transfer-peer-flow__dot,
.transfer-peer-flow[data-phase="requesting"] .transfer-peer-flow__dot {
  animation: dot-wave 1.2s cubic-bezier(0.25, 1, 0.5, 1) infinite;
}

.transfer-peer-flow[data-phase="connecting"] .transfer-peer-flow__dot:nth-child(2),
.transfer-peer-flow[data-phase="requesting"] .transfer-peer-flow__dot:nth-child(2) {
  animation-delay: 120ms;
}

.transfer-peer-flow[data-phase="connecting"] .transfer-peer-flow__dot:nth-child(3),
.transfer-peer-flow[data-phase="requesting"] .transfer-peer-flow__dot:nth-child(3) {
  animation-delay: 240ms;
}

.transfer-peer-flow[data-phase="transferring"] .transfer-peer-flow__dash-line {
  animation: transfer-dash-flow 800ms linear infinite;
}

@media (prefers-reduced-motion: reduce) {
  .transfer-peer-flow .transfer-peer-flow__dot,
  .transfer-peer-flow .transfer-peer-flow__dash-line {
    animation: none;
  }
}
```

- [ ] **Step 5: Run the focused component test**

Run:

```bash
bun run --cwd apps/web test -- TransferPeerFlow.test.tsx
```

Expected: PASS for all `TransferPeerFlow` cases.

- [ ] **Step 6: Commit the shared component**

```bash
git add apps/web/src/components/TransferPeerFlow.tsx apps/web/src/components/TransferPeerFlow.test.tsx apps/web/src/index.css
git commit -m "feat(web): unify participant connection flow"
```

### Task 2: Integrate the same flow into sender and receiver panels

**Files:**
- Modify: `apps/web/src/components/TransferPanel.test.tsx:102-144`
- Modify: `apps/web/src/components/TransferPanel.tsx:81-100,182-204`
- Modify: `apps/web/src/components/ReceiverPanel.test.tsx:25-72`
- Modify: `apps/web/src/components/ReceiverPanel.tsx:1-114`
- Modify: `apps/web/src/App.test.tsx:257-278,1392-1400`
- Modify: `apps/web/src/App.tsx:2080-2085`

**Interfaces:**
- Consumes: Task 1's expanded `TransferPeerFlowPhase` and optional sender support.
- Produces: `ReceiverPanelProps.connected: boolean`; `ReceiverPanel` no longer accepts a separate `visitor` prop, and both panels render the same sender-left/receiver-right component without a duplicate receiver identity.

- [ ] **Step 1: Update sender-panel tests for the unified row**

Replace the first two `TransferPanel` tests with:

```tsx
test('uses the unified flow and filters receivers to the active transfer', () => {
  const initialProps = createProps()
  const { rerender } = render(<TransferPanel {...initialProps} />)
  const status = screen.getByRole('status')

  expect(screen.queryByText('2 位接收者已连接')).toBeNull()
  expect(status.getAttribute('data-phase')).toBe('idle')
  expect(screen.getByTitle(sender.displayName)).not.toBeNull()
  expect(screen.getByTitle(receiverOne.displayName)).not.toBeNull()
  expect(screen.getByTitle(receiverTwo.displayName)).not.toBeNull()

  const activeActivity = createActiveFileTransfer('file-flow')
  activeActivity.peerIds = [receiverTwo.id]
  rerender(<TransferPanel {...initialProps} activity={activeActivity} />)

  expect(status.getAttribute('data-phase')).toBe('transferring')
  expect(status.querySelector('.transfer-peer-flow__dash')).not.toBeNull()
  expect(screen.queryByTitle(receiverOne.displayName)).toBeNull()
  expect(screen.getByTitle(receiverTwo.displayName)).not.toBeNull()
})

test('shows the waiting flow when no receiver is ready', () => {
  render(<TransferPanel {...createProps({ receivers: [] })} />)
  const status = screen.getByRole('status')

  expect(status.getAttribute('data-phase')).toBe('connecting')
  expect(status.querySelectorAll('.transfer-peer-flow__dot')).toHaveLength(3)
  expect(status.querySelector('.transfer-peer-flow__placeholder')).not.toBeNull()
})
```

- [ ] **Step 2: Update receiver-panel tests for readiness and remove the duplicated identity**

Replace the current `ReceiverPanel` test body with:

```tsx
test('uses one sender-left receiver-group flow across receiver states', () => {
  const { rerender } = render(
    <ReceiverPanel
      sender={sender}
      receivers={[receiver]}
      connected={false}
      state={{ status: 'waiting' }}
    />,
  )

  const status = screen.getByRole('status', { name: '正在建立点对点连接' })
  expect(status.getAttribute('data-phase')).toBe('connecting')
  expect(screen.getAllByTitle('接收者乙')).toHaveLength(1)
  expect(screen.getByTitle('发送者甲')).not.toBeNull()

  rerender(
    <ReceiverPanel
      sender={sender}
      receivers={[receiver]}
      connected
      state={{ status: 'waiting' }}
    />,
  )
  expect(status.getAttribute('data-phase')).toBe('idle')
  expect(status.querySelector('.transfer-peer-flow__line')).not.toBeNull()

  rerender(
    <ReceiverPanel
      sender={sender}
      receivers={[receiver]}
      connected
      state={{ status: 'receiving' }}
    />,
  )
  expect(status.getAttribute('data-phase')).toBe('transferring')
  expect(status.querySelector('.transfer-peer-flow__dash')).not.toBeNull()

  rerender(
    <ReceiverPanel
      sender={sender}
      receivers={[receiver]}
      connected={false}
      state={{ status: 'error', message: '发送者已离开' }}
    />,
  )
  expect(status.getAttribute('data-phase')).toBe('error')
  expect(status.querySelector('[data-state-icon="link_off"]')).not.toBeNull()
  expect(screen.getByText('发送者已离开')).not.toBeNull()
})
```

- [ ] **Step 3: Update the App mock test to expose receiver readiness**

Remove the mock's obsolete `visitor` prop, add `connected`, write it to `data-connected`, and replace the receiver-panel assertions with the current public contract:

```tsx
default: ({ sender, receivers, connected, state }: {
  sender?: PublicVisitor
  receivers: PublicVisitor[]
  connected: boolean
  state: { status: string }
}) => (
  <div
    data-testid="receiver-panel"
    data-sender-id={sender?.id ?? ''}
    data-receiver-ids={receivers.map(receiver => receiver.id).join(',')}
    data-connected={String(connected)}
  >
    {state.status}
  </div>
)
```

```tsx
const panel = screen.getByTestId('receiver-panel')
expect(panel.dataset.senderId).toBe(sender.id)
expect(panel.dataset.receiverIds).toBe(receiver.id)
expect(panel.dataset.connected).toBe('true')
expect(screen.queryByRole('button', { name: '分享房间' })).toBeNull()
```

- [ ] **Step 4: Run the integration tests and confirm the implementation is still red**

Run:

```bash
bun run --cwd apps/web test -- TransferPanel.test.tsx ReceiverPanel.test.tsx App.test.tsx
```

Expected: FAIL because `TransferPanel` still maps an empty room to `idle`, `ReceiverPanel` has no `connected` prop and duplicates the current receiver avatar, and `App` does not pass readiness.

- [ ] **Step 5: Map sender phases and remove the extra connected-count row**

In `TransferPanel.tsx`, keep `connectedLabel` for the accessible status text, change the fallback phase, and replace the current top wrapper with the shared flow alone:

```tsx
const flowPhase = activity?.phase ?? (receivers.length > 0 ? 'idle' : 'connecting')
```

```tsx
<div className="w-full">
  <TransferPeerFlow
    sender={visitor}
    receivers={flowReceivers}
    phase={flowPhase}
    accessibleLabel={activityLabel}
    onClick={receivers.length > 0 && !pickerLocked
      ? () => setPickerOpen(true)
      : undefined}
    selectedCount={selectedCount}
    triggerRef={pickerTriggerRef}
  />
</div>
```

- [ ] **Step 6: Map receiver phases and delete the duplicate receiver identity row**

Remove the direct `Avatar` import and the unused `visitor` prop, add `connected` to `ReceiverPanelProps`, and use the shared flow as the only top row:

```tsx
export type ReceiverPanelProps = {
  sender?: PublicVisitor
  receivers: PublicVisitor[]
  connected: boolean
  state: ReceiverPanelState
}
```

```tsx
const flowPhase = state.status === 'error'
  ? 'error'
  : state.status === 'receiving'
    ? 'transferring'
    : connected
      ? 'idle'
      : 'connecting'
const flowLabel = state.status === 'error'
  ? '传输连接已中断'
  : state.status === 'receiving'
    ? '正在接收来自发送者的文件'
    : connected
      ? `${String(receivers.length)} 位接收者在房间内，点对点已连接`
      : '正在建立点对点连接'
```

```tsx
<TransferPeerFlow
  sender={sender}
  receivers={receivers}
  phase={flowPhase}
  accessibleLabel={flowLabel}
/>
```

- [ ] **Step 7: Pass receiver-side peer readiness from `App`**

Remove `visitor={roomView.session.visitor}` from the existing `ReceiverPanel` call and add this prop:

```tsx
connected={Boolean(
  receiverSender && state.readyPeerIds.includes(receiverSender.id)
)}
```

- [ ] **Step 8: Run focused integration tests**

Run:

```bash
bun run --cwd apps/web test -- TransferPeerFlow.test.tsx TransferPanel.test.tsx ReceiverPanel.test.tsx App.test.tsx
```

Expected: PASS for the shared component and both role integrations, including App readiness propagation.

- [ ] **Step 9: Commit role integration**

```bash
git add apps/web/src/components/TransferPanel.tsx apps/web/src/components/TransferPanel.test.tsx apps/web/src/components/ReceiverPanel.tsx apps/web/src/components/ReceiverPanel.test.tsx apps/web/src/App.tsx apps/web/src/App.test.tsx
git commit -m "feat(web): share participant flow across room roles"
```

### Task 3: Verify behavior, responsiveness, and motion accessibility

**Files:**
- Modify only if verification finds a task-scoped defect: the files listed in Tasks 1 and 2.
- Test: all `apps/web` unit tests and build-time checks.

**Interfaces:**
- Consumes: the completed shared flow and role integrations.
- Produces: verified desktop/narrow-screen layouts, verified reduced-motion fallback, and a clean build.

- [ ] **Step 1: Run the full web quality gate**

Run each command separately:

```bash
bun run --cwd apps/web test
bun run --cwd apps/web typecheck
bun run --cwd apps/web lint
bun run --cwd apps/web build
```

Expected: all Vitest suites pass, TypeScript exits 0, oxlint reports no errors, and Vite completes a production build.

- [ ] **Step 2: Check whitespace and task scope**

Run through Python subprocesses so output remains UTF-8 safe:

```python
import subprocess
from pathlib import Path

root = Path.cwd()
for args in [
    ['git', 'diff', '--check'],
    ['git', 'status', '--short'],
    ['git', 'diff', '--stat'],
]:
    result = subprocess.run(
        args,
        cwd=root,
        capture_output=True,
        text=True,
        encoding='utf-8',
        errors='replace',
        check=False,
    )
    print('$', ' '.join(args))
    print(result.stdout)
    if result.returncode != 0:
        raise SystemExit(result.returncode)
```

Expected: `git diff --check` exits 0 and only the planned frontend files plus this plan are present in task scope.

- [ ] **Step 3: Perform browser visual QA at desktop and mobile widths**

Start the existing development stack with `bun run dev`, then inspect both sender and receiver room views in a real browser at approximately 1440×900 and 390×844. Verify:

```text
Sender avatar remains left.
Receiver group remains right.
Five receivers fit without overflow.
Six receivers render four avatars plus a “6” badge.
No-receiver state shows a placeholder and pulsing dots.
Connected state shows a solid line.
Transfer state shows right-moving dashes.
Receiver view has no duplicate local avatar.
Recipient picker still opens from the sender flow by mouse and keyboard.
No content clips or creates horizontal scrolling at 390 px.
```

Expected: both roles match the approved layout and all listed checks pass.

- [ ] **Step 4: Verify reduced motion**

Enable the browser's reduced-motion emulation and revisit connecting and transferring states.

Expected: dots and dash offset are static while their shapes and state labels remain visible and understandable.

- [ ] **Step 5: Commit any verification-only fixes, if the working tree contains them**

Stage only task-scoped files, then run:

```bash
git commit -m "fix(web): polish unified participant flow"
```

If visual QA requires no changes, do not create an empty commit.
