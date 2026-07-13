# Interaction Feedback UX Implementation Plan

> For agentic workers: use the approved interaction design and execute the tasks in order. Steps use checkbox syntax for tracking.

**Goal:** Improve clickable affordances, transfer-mode selection, recipient selection visibility, and received-text copy feedback without changing transfer behavior or protocol state.

**Architecture:** Keep the current React component boundaries and existing ReceivedTextCopyStatus state machine. Add one narrowly scoped global CSS rule for enabled interactive elements, use a decorative slider behind the existing semantic tabs, expose recipient selection through native checkbox semantics plus stronger row styling, and render persistent copy feedback from the existing status prop.

**Tech Stack:** React 19, TypeScript, Tailwind CSS v4, Vitest, Testing Library, Bun 1.3.14, Vite.

## Global Constraints

- Use Bun 1.3.14 from the repository packageManager and engines declarations.
- Preserve the dark visual system: white-opacity surfaces, #5e11d1 accent, no gradients, no shadows, and no new component library.
- Keep native button, link, label, tab, and checkbox semantics.
- Keep all changed controls at or above the existing 44px touch-target convention.
- Preserve the existing tab ARIA attributes, roving tabIndex, Arrow/Home/End keyboard behavior, and native checkbox checked state.
- Do not change WebRTC signaling, transfer protocol, clipboard API usage, room membership, or recipient-selection data flow.
- Do not add a timeout that hides copy success.
- Respect prefers-reduced-motion for the new tab slider.
- Do not stage or modify the existing user change in .vscode/settings.json.

## File Map

- Modify apps/web/src/index.css: enabled-interactive cursor rule and reduced-motion slider handling.
- Modify apps/web/src/App.tsx: About link and About icon affordances.
- Modify apps/web/src/components/TransferPanel.tsx: sliding transfer-mode indicator.
- Modify apps/web/src/components/RecipientPickerDialog.tsx: selected row and checkbox visuals.
- Modify apps/web/src/components/ReceivedTextDialog.tsx: persistent copy feedback.
- Test apps/web/src/App.test.tsx, TransferPanel.test.tsx, RecipientPickerDialog.test.tsx, and ReceivedTextDialog.test.tsx.

---

### Task 1: Add consistent clickable affordances and About-link treatment

**Files:**
- Modify apps/web/src/index.css after the theme declarations.
- Modify apps/web/src/App.tsx at the lobby About button and room toolbar About button.
- Test apps/web/src/App.test.tsx in the existing lobby About test.

**Interfaces:**
- Consumes existing button, link, role=button, and selectable label elements.
- Produces pointer cursors for enabled controls while disabled and locked controls retain unavailable cursors.

- [ ] Step 1: Add failing About-style assertions.

In the existing lobby About test, locate the button before clicking it and add:

~~~tsx
const aboutButton = await screen.findByRole('button', {
  name: '关于 P2P Transmission',
})
expect(aboutButton.className).toContain('cursor-pointer')
expect(aboutButton.className).toContain('underline')
expect(aboutButton.className).toContain('underline-offset-4')
await user.click(aboutButton)
~~~

Run:

~~~text
bun run --cwd apps/web test -- src/App.test.tsx
~~~

Expected: FAIL because the current lobby button has none of these utilities.

- [ ] Step 2: Add the enabled-interactive cursor rule.

Add this exact CSS after the @theme block in apps/web/src/index.css:

~~~css
button:not(:disabled),
a[href],
[role="button"]:not([aria-disabled="true"]),
label:has(input:not(:disabled)) {
  cursor: pointer;
}
~~~

The selectors exclude disabled native buttons and locked role=button drop zones. Existing disabled:cursor-not-allowed and disabled:cursor-wait utilities remain effective.

- [ ] Step 3: Update both About controls.

Use this exact lobby button class:

~~~tsx
className="mt-5 min-h-11 cursor-pointer self-center px-3 text-xs text-amber-50/50 underline decoration-amber-50/30 underline-offset-4 transition-colors hover:text-amber-50/80 hover:decoration-amber-50/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
~~~

Add cursor-pointer to the room toolbar About icon button without changing its size, label, title, or handler:

~~~tsx
className="flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-full border border-transparent text-amber-50/50 transition-colors hover:bg-white/5 hover:text-amber-50/80 focus-visible:border-accent focus-visible:outline-none"
~~~

- [ ] Step 4: Run the focused test and diff check.

~~~text
bun run --cwd apps/web test -- src/App.test.tsx
git diff --check
~~~

Expected: About tests pass and only the requested affordance changes are present.

- [ ] Step 5: Commit.

~~~text
git add apps/web/src/index.css apps/web/src/App.tsx apps/web/src/App.test.tsx
git commit -m "fix: clarify clickable controls"
~~~

### Task 2: Convert transfer tabs to a sliding segmented control

**Files:**
- Modify apps/web/src/components/TransferPanel.tsx in the tablist around lines 226-270.
- Modify apps/web/src/index.css in the reduced-motion media query if needed.
- Test apps/web/src/components/TransferPanel.test.tsx in the existing tab keyboard test.

**Interfaces:**
- Consumes the existing tab state, selectTab function, tab refs, and handleTabKeyDown.
- Produces data-active-tab=text|file on the tab list and one decorative data-testid=transfer-tab-slider element.

- [ ] Step 1: Add failing slider assertions.

Add these assertions to the existing keyboard test after obtaining textTab and fileTab:

~~~tsx
const tablist = screen.getByRole('tablist', { name: '传输类型' })
const slider = () => tablist.querySelector('[data-testid="transfer-tab-slider"]')

expect(tablist.getAttribute('data-active-tab')).toBe('text')
expect(slider()?.getAttribute('aria-hidden')).toBe('true')
expect(slider()?.className).toContain('translate-x-0')

await user.click(fileTab)
expect(tablist.getAttribute('data-active-tab')).toBe('file')
expect(slider()?.className).toContain('translate-x-full')

await user.click(textTab)
expect(tablist.getAttribute('data-active-tab')).toBe('text')
expect(slider()?.className).toContain('translate-x-0')
~~~

Run:

~~~text
bun run --cwd apps/web test -- src/components/TransferPanel.test.tsx
~~~

Expected: FAIL because the tab list has no slider or data-active-tab attribute.

- [ ] Step 2: Replace only the tablist wrapper and tab classes.

The wrapper must become:

~~~tsx
<div
  className="relative grid w-full grid-cols-2 rounded-xl bg-white/5 p-1 sm:w-auto sm:min-w-64"
  role="tablist"
  aria-label="传输类型"
  data-active-tab={tab}
>
  <span
    data-testid="transfer-tab-slider"
    aria-hidden="true"
    className={`pointer-events-none absolute inset-y-1 left-1 w-[calc(50%-0.25rem)] rounded-lg bg-white/10 transition-transform duration-200 ease-out motion-reduce:transition-none ${tab === 'file' ? 'translate-x-full' : 'translate-x-0'}`}
  />
  {/* Keep the two existing buttons and all their ARIA, ref, disabled, click, and key handlers here. */}
</div>
~~~

Replace the text tab className with:

~~~tsx
className={`relative z-10 min-h-11 rounded-lg border border-transparent px-4 text-sm transition-colors focus-visible:border-accent focus-visible:outline-none disabled:cursor-not-allowed ${tab === 'text' ? 'text-amber-50/80' : 'text-amber-50/60 hover:text-amber-50/80'}`}
~~~

Replace the file tab className with:

~~~tsx
className={`relative z-10 min-h-11 rounded-lg border border-transparent px-4 text-sm transition-colors focus-visible:border-accent focus-visible:outline-none disabled:cursor-not-allowed ${tab === 'file' ? 'text-amber-50/80' : 'text-amber-50/60 hover:text-amber-50/80'}`}
~~~

The comment above describes placement, not code to paste: retain the concrete existing button markup and attributes. Remove the old active bg-white/10 classes because the slider owns that surface.

- [ ] Step 3: Verify keyboard and reduced-motion behavior.

Run:

~~~text
bun run --cwd apps/web test -- src/components/TransferPanel.test.tsx
git diff --check
~~~

Expected: all TransferPanel tests pass, ArrowRight/ArrowLeft/Home/End still move focus and selection, and the slider class includes motion-reduce:transition-none.

- [ ] Step 4: Commit.

~~~text
git add apps/web/src/components/TransferPanel.tsx apps/web/src/index.css apps/web/src/components/TransferPanel.test.tsx
git commit -m "fix: add transfer tab slider feedback"
~~~

### Task 3: Make recipient selection unmistakable

**Files:**
- Modify apps/web/src/components/RecipientPickerDialog.tsx in the receiver row map around lines 126-155.
- Test apps/web/src/components/RecipientPickerDialog.test.tsx in the selected-state test.

**Interfaces:**
- Consumes checked, toggle, draftIds, and the existing native checkbox.
- Produces data-selected=true|false on each row and a visible data-testid=recipient-check-indicator.

- [ ] Step 1: Add failing selected-row assertions.

Add these assertions to the existing selected-state test:

~~~tsx
const selectedCheckbox = screen.getByRole('checkbox', { name: receiverOne.displayName }) as HTMLInputElement
const selectedRow = selectedCheckbox.closest('label')
const unselectedCheckbox = screen.getByRole('checkbox', { name: receiverTwo.displayName }) as HTMLInputElement
const unselectedRow = unselectedCheckbox.closest('label')

expect(selectedRow?.getAttribute('data-selected')).toBe('true')
expect(selectedRow?.className).toContain('bg-accent/15')
expect(selectedRow?.className).toContain('border-accent/60')
expect(selectedRow?.querySelector('[data-testid="recipient-check-indicator"]')).not.toBeNull()
expect(unselectedRow?.getAttribute('data-selected')).toBe('false')
expect(unselectedRow?.className).not.toContain('bg-accent/15')
expect(selectedCheckbox.checked).toBe(true)
expect(unselectedCheckbox.checked).toBe(false)
~~~

Run:

~~~text
bun run --cwd apps/web test -- src/components/RecipientPickerDialog.test.tsx
~~~

Expected: FAIL because these attributes and selected surfaces do not exist.

- [ ] Step 2: Replace the row presentation while retaining native checkbox semantics.

Use this exact row structure inside receivers.map:

~~~tsx
<label
  key={receiver.id}
  data-selected={checked ? 'true' : 'false'}
  className={`flex min-h-14 cursor-pointer items-center gap-3 rounded-xl border px-3 transition-[background-color,border-color] focus-within:border-accent focus-within:outline-none ${checked ? 'border-accent/60 bg-accent/15' : 'border-amber-50/10 hover:bg-white/5'}`}
>
  <input
    type="checkbox"
    className="peer sr-only"
    checked={checked}
    onChange={() => toggle(receiver.id)}
    aria-label={receiver.displayName}
  />
  <span
    data-testid="recipient-check-indicator"
    aria-hidden="true"
    className={`flex size-5 shrink-0 items-center justify-center rounded-md border transition-[background-color,border-color,color] motion-reduce:transition-none ${checked ? 'border-accent bg-accent text-white' : 'border-amber-50/30 bg-transparent text-transparent'}`}
  >
    <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>check</span>
  </span>
  <Avatar seed={receiver.avatarSeed} label={receiver.displayName} className="shrink-0" />
  <span className="min-w-0 flex-1 truncate text-sm text-amber-50/80">
    {receiver.displayName}
  </span>
</label>
~~~

The native checkbox remains the semantic and keyboard source. The indicator is decorative; selected row background and border communicate the state without relying on the icon alone.

- [ ] Step 3: Run picker and transfer regression tests.

~~~text
bun run --cwd apps/web test -- src/components/RecipientPickerDialog.test.tsx src/components/TransferPanel.test.tsx
~~~

Expected: selection toggling, select all, clear all, empty-selection validation, ordered confirmation, and sender integration all pass.

- [ ] Step 4: Commit.

~~~text
git add apps/web/src/components/RecipientPickerDialog.tsx apps/web/src/components/RecipientPickerDialog.test.tsx
git commit -m "fix: strengthen recipient selection feedback"
~~~

### Task 4: Make received-text copy success persistent and visible

**Files:**
- Modify apps/web/src/components/ReceivedTextDialog.tsx around the copy maps and action area.
- Test apps/web/src/components/ReceivedTextDialog.test.tsx in the existing copy success/failure test.

**Interfaces:**
- Consumes the existing ReceivedTextCopyStatus union and onCopy/onClose callbacks.
- Produces a state-specific icon, data-copy-status, and a stable data-testid=copy-status-message polite status region.

- [ ] Step 1: Add failing status assertions.

After the idle render, assert:

~~~tsx
expect(screen.getByTestId('copy-status-message').textContent).toBe('')
~~~

After rerendering copied, assert:

~~~tsx
expect(screen.getByTestId('copy-status-message').textContent).toBe('文本已复制到剪贴板')
expect(screen.getByTestId('copy-status-message').getAttribute('role')).toBe('status')
expect(screen.getByRole('button', { name: '已复制' }).querySelector('.material-symbols-outlined')?.textContent).toBe('check_circle')
~~~

After rerendering error, assert:

~~~tsx
expect(screen.getByTestId('copy-status-message').textContent).toBe('复制失败，请重试')
expect(screen.getByRole('button', { name: '复制失败' }).querySelector('.material-symbols-outlined')?.textContent).toBe('error')
~~~

Run:

~~~text
bun run --cwd apps/web test -- src/components/ReceivedTextDialog.test.tsx
~~~

Expected: FAIL because the current dialog has no visible status message or state-specific icon.

- [ ] Step 2: Add presentation maps next to copyLabels.

~~~tsx
const copyIcons: Record<ReceivedTextCopyStatus, string> = {
  idle: 'content_copy',
  copying: 'progress_activity',
  copied: 'check_circle',
  error: 'error',
}

const copyStatusMessages: Record<ReceivedTextCopyStatus, string> = {
  idle: '',
  copying: '正在复制到剪贴板…',
  copied: '文本已复制到剪贴板',
  error: '复制失败，请重试',
}
~~~

- [ ] Step 3: Replace the copy button and hidden live region.

Use this button class and content:

~~~tsx
<button
  type="button"
  data-copy-status={copyStatus}
  className={`flex min-h-11 items-center justify-center gap-2 rounded-xl border px-4 text-sm tracking-wider transition-[background-color,border-color,color] focus-visible:border-accent focus-visible:outline-none disabled:cursor-wait disabled:text-amber-50/20 ${copyStatus === 'copied' ? 'border-accent/60 bg-accent/10 text-accent' : copyStatus === 'error' ? 'border-amber-50/30 bg-white/5 text-amber-50/80 hover:bg-white/10' : 'border-amber-50/15 text-amber-50/60 hover:bg-white/5 hover:text-amber-50/80'}`}
  disabled={copyStatus === 'copying'}
  onClick={onCopy}
>
  <span className="material-symbols-outlined" style={{ fontSize: '17px' }} aria-hidden="true">
    {copyIcons[copyStatus]}
  </span>
  {copyLabels[copyStatus]}
</button>
~~~

Replace the current sr-only live span with:

~~~tsx
<p
  data-testid="copy-status-message"
  className="mt-2 min-h-5 text-xs leading-5 text-amber-50/60"
  role="status"
  aria-live="polite"
  aria-atomic="true"
>
  {copyStatusMessages[copyStatus]}
</p>
~~~

The min-h-5 keeps the dialog geometry stable in idle and copied states. The parent App already resets status to idle on close and when the current incoming text changes, so no App state change is needed.

- [ ] Step 4: Verify copied state is retryable and persistent.

Add to the copied-state part of the test:

~~~tsx
await user.click(screen.getByRole('button', { name: '已复制' }))
expect(onCopy).toHaveBeenCalledTimes(2)
~~~

Run:

~~~text
bun run --cwd apps/web test -- src/components/ReceivedTextDialog.test.tsx
~~~

Expected: copied remains visible, the dialog remains open, clicking the copied button calls onCopy again, and only copying disables the button.

- [ ] Step 5: Commit.

~~~text
git add apps/web/src/components/ReceivedTextDialog.tsx apps/web/src/components/ReceivedTextDialog.test.tsx
git commit -m "fix: persist received text copy feedback"
~~~

### Task 5: Run integration checks and final regression review

**Files:**
- Test apps/web/src/App.test.tsx.
- Test apps/web/src/components/TransferPanel.test.tsx.
- Test apps/web/src/components/RecipientPickerDialog.test.tsx.
- Test apps/web/src/components/ReceivedTextDialog.test.tsx.

**Interfaces:**
- Consumes all four completed UI changes and the existing App copy lifecycle.
- Produces a verified frontend build and repository verification result with no API, protocol, or deployment changes.

- [ ] Step 1: Run focused frontend tests.

~~~text
bun run --cwd apps/web test -- src/App.test.tsx src/components/TransferPanel.test.tsx src/components/RecipientPickerDialog.test.tsx src/components/ReceivedTextDialog.test.tsx
~~~

Expected: all focused tests pass.

- [ ] Step 2: Run lint and typecheck.

~~~text
bun run --cwd apps/web lint
bun run --cwd apps/web typecheck
~~~

Expected: both exit 0 with no new warnings or type errors.

- [ ] Step 3: Build the production frontend.

~~~text
bun run --cwd apps/web build
~~~

Expected: TypeScript project build and Vite production build complete successfully.

- [ ] Step 4: Run repository verification.

~~~text
bun run verify
~~~

Expected: workspace lint, tests, typecheck, and builds pass.

- [ ] Step 5: Review the final diff and working tree.

~~~text
git diff --check
git status --short --branch
git diff origin/main..HEAD --stat
git diff origin/main..HEAD -- apps/web/src/index.css apps/web/src/App.tsx apps/web/src/components/TransferPanel.tsx apps/web/src/components/RecipientPickerDialog.tsx apps/web/src/components/ReceivedTextDialog.tsx
~~~

Confirm .vscode/settings.json remains only the pre-existing unstaged user change, and no protocol, API, or deployment file changed.

- [ ] Step 6: Commit any test-only correction only if verification required one.

Do not create an empty commit. If a test-only correction was needed:

~~~text
git add apps/web/src/App.test.tsx apps/web/src/components/TransferPanel.test.tsx apps/web/src/components/RecipientPickerDialog.test.tsx apps/web/src/components/ReceivedTextDialog.test.tsx
git commit -m "test: cover interaction feedback states"
~~~

## Self-review checklist

- Spec coverage: Task 1 covers pointer cursors and About underline; Task 2 covers the tab slider and reduced motion; Task 3 covers visible recipient selection; Task 4 covers persistent copy status, live messaging, and retry; Task 5 covers accessibility-sensitive component tests and production verification.
- Review scan: every implementation task includes exact paths, code, commands, and expected outcomes.
- Type consistency: the plan keeps ReceivedTextCopyStatus, onCopy(): void, and onClose(): void; data-active-tab values are the existing Tab union values; data-selected does not replace native checked semantics.
- Scope check: all work remains in the approved in-place frontend interaction enhancement and does not require protocol, persistence, or deployment changes.
