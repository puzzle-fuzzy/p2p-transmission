# 房间码回车提交 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or **superpowers:executing-plans** to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让完整 6 位房间码输入后按回车与点击“请求加入/加入房间”执行完全相同的提交逻辑。

**Architecture:** 将 `RoomJoin` 的验证码输入和加入按钮放入原生 `<form>`，由一个 `handleSubmit` 负责阻止默认跳转、检查 `busy` 和验证码长度，并调用现有 `onSubmit(code)`。创建房间按钮保持普通 `button`，避免回车误触发创建房间。

**Tech Stack:** React 19、TypeScript、Vitest、Testing Library、Bun 1.3.14。

## Global Constraints

- 完整 6 位房间码在任意验证码输入框按 Enter 时只提交一次。
- 房间码不足 6 位或 `busy` 为 true 时不提交。
- 保留数字过滤、自动聚焦、粘贴、邀请模式、错误展示和现有按钮文案。
- 不修改 API、房间状态、请求流程、路由、依赖或 lockfile。
- 保留现有 `.vscode/settings.json` 本地未提交修改，不将其纳入本次提交。

---

### Task 1: Add and implement native form submission for room join

**Files:**
- Modify: `X:\p2p-transmission\apps\web\src\components\RoomJoin.tsx`
- Test: `X:\p2p-transmission\apps\web\src\components\RoomJoin.test.tsx`

**Interfaces:**
- Consumes: existing `RoomJoinProps.onSubmit(code: string)`, `busy`, `digits`, and `code` state.
- Produces: the same `onSubmit(code)` call from both the submit button click and Enter key submission.

- [x] **Step 1: Add failing Enter behavior tests**

Append these tests inside the existing `describe('RoomJoin', ...)` block in `RoomJoin.test.tsx`:

```tsx
  test('submits the complete room code when pressing Enter', async () => {
    const user = userEvent.setup()
    const props = renderRoomJoin()
    const inputs = roomCodeInputs()

    for (const [index, input] of inputs.entries()) {
      await user.type(input, String(index + 1))
    }
    await user.keyboard('{Enter}')

    expect(props.onSubmit).toHaveBeenCalledTimes(1)
    expect(props.onSubmit).toHaveBeenCalledWith('123456')
  })

  test('does not submit an incomplete room code when pressing Enter', async () => {
    const user = userEvent.setup()
    const props = renderRoomJoin()
    const inputs = roomCodeInputs()

    for (const [index, input] of inputs.slice(0, 5).entries()) {
      await user.type(input, String(index + 1))
    }
    await user.keyboard('{Enter}')

    expect(props.onSubmit).not.toHaveBeenCalled()
  })
```

- [x] **Step 2: Run the focused test and confirm it fails**

Run:

```bash
bun run --cwd apps/web test -- RoomJoin.test.tsx
```

Expected: the existing click tests pass, while the new complete-code Enter test fails because the current button is not a form submit control.

- [x] **Step 3: Add one shared form submit handler**

In `RoomJoin.tsx`, import the `FormEvent` type and add this handler after `submitLabel`:

```tsx
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (busy || code.length !== 6) return
    onSubmit(code)
  }
```

Change the root wrapper from a `div` to:

```tsx
    <form className="flex w-full max-w-sm flex-col items-center" onSubmit={handleSubmit}>
```

Change only the join button to `type="submit"` and remove its `onClick` handler:

```tsx
      <button
        type="submit"
        ...
      >
```

Keep the create-room button as `type="button"` with its existing `onClick={onCreateRoom}`. Close the root element with `</form>`.

- [x] **Step 4: Run focused and full verification**

Run:

```bash
bun run --cwd apps/web test -- RoomJoin.test.tsx
bun run verify
```

Expected: all focused tests pass, including both Enter cases; full lint, tests, typecheck, and build pass without changes outside the intended component and test files.

- [x] **Step 5: Review the focused diff and commit**

Run:

```bash
git diff --check
git diff -- apps/web/src/components/RoomJoin.tsx apps/web/src/components/RoomJoin.test.tsx
git status --short
git add apps/web/src/components/RoomJoin.tsx apps/web/src/components/RoomJoin.test.tsx docs/superpowers/plans/2026-07-13-room-join-enter-submit.md
git commit -m "fix: submit room join on enter"
```

Expected: only the RoomJoin component, its focused tests, and this completed plan are staged; `.vscode/settings.json` remains unstaged.
