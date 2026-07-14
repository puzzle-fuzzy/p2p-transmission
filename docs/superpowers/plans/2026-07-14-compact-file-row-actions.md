# 紧凑文件行操作按钮实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将文件列表中的复制、下载和移除 action 统一缩小为 36×36px，并同步收紧文件行内容预留空间。

**Architecture:** 保持 `FileTransferRow` 的进度层、内容层和右侧 action rail 结构不变，只把有 action 时的内容右内边距从 `pr-14` 改为 `pr-12`。三个具体 action 使用 `size-9` 和 15px 图标，保留现有 rounded、ARIA、事件和业务逻辑。

**Tech Stack:** React 19、TypeScript、Tailwind CSS v4、Vitest、Testing Library、Bun 1.3.14。

## Global Constraints

- 文件列表复制、下载、移除按钮必须为 `size-9`（36×36px）。
- 文件行有 action 时使用 `pr-12`，无 action 时继续使用 `pr-3`。
- 复制、下载、移除图标使用约 15px；底部主操作按钮不变。
- 保留 `rounded-lg`、`rounded-r-lg`、ARIA 标签、focus-visible 反馈和事件处理。
- 不修改进度计算、传输协议、复制/下载/移除业务逻辑或其他页面按钮。
- 使用项目锁定的 Bun 版本运行测试、lint、typecheck、build 和 E2E。

---

### Task 1: 收紧 FileTransferRow 内容预留空间

**Files:**
- Modify: `apps/web/src/components/FileTransferRow.test.tsx:34-42`，把有 action 的内边距断言改为 `pr-12`。
- Modify: `apps/web/src/components/FileTransferRow.tsx:86-90`，把 action 分支的 `pr-14` 改为 `pr-12`。

**Interfaces:**
- Consumes: 现有 `FileTransferRowProps`、`action?: ReactNode` 和文件行状态/进度渲染。
- Produces: 相同的 `FileTransferRow` props、progressbar DOM 和 action slot；无 action 仍使用 `pr-3`。

- [ ] **Step 1: 更新测试为新的内边距契约**

在 `FileTransferRow.test.tsx` 中将：

```tsx
expect(content.className).toContain('pr-14')
```

改为：

```tsx
expect(content.className).toContain('pr-12')
```

保留后续无 action 的 `pr-3` 断言。

- [ ] **Step 2: 运行测试确认旧实现失败**

运行：

```text
bun run --cwd apps/web test -- src/components/FileTransferRow.test.tsx
```

预期：有 action 的内边距断言失败，因为旧实现仍包含 `pr-14`。

- [ ] **Step 3: 实现最小内边距调整**

在 `FileTransferRow.tsx` 中将 class 逻辑改为：

```tsx
className={`relative z-10 flex min-h-11 items-center gap-3 py-2 pl-3 ${
  action ? 'pr-12' : 'pr-3'
}`}
```

不修改进度层、action slot、状态标签、ARIA 属性或任何计算逻辑。

- [ ] **Step 4: 运行 FileTransferRow 测试确认通过**

运行：

```text
bun run --cwd apps/web test -- src/components/FileTransferRow.test.tsx
```

预期：2 个测试全部通过。

- [ ] **Step 5: 提交 Task 1**

```text
git add apps/web/src/components/FileTransferRow.tsx apps/web/src/components/FileTransferRow.test.tsx
git commit -m "fix(web): compact file row content spacing"
```

### Task 2: 将文件列表 action 统一缩小到 36px

**Files:**
- Modify: `apps/web/src/components/IncomingFileRequestDialog.tsx:275-301`，复制/下载按钮改为 `size-9` 和 15px 图标。
- Modify: `apps/web/src/components/IncomingFileRequestDialog.test.tsx:205-218`，断言复制/下载按钮为 `size-9`。
- Modify: `apps/web/src/components/TransferPanel.tsx:297-309`，移除按钮改为 `size-9` 和 15px 图标。
- Modify: `apps/web/src/components/TransferPanel.test.tsx:345-353`，断言移除按钮为 `size-9`。

**Interfaces:**
- Consumes: Task 1 的 `pr-12` 内容空间；现有复制、下载和移除按钮的 props、事件和 ARIA 标签。
- Produces: 相同的 button/anchor 元素和交互，只改变按钮/图标尺寸。

- [ ] **Step 1: 添加尺寸失败断言**

在 `IncomingFileRequestDialog.test.tsx` 现有圆角断言后加入：

```tsx
expect(firstDownload.className).toContain('size-9')
expect(secondDownload.className).toContain('size-9')
expect(copyTextFile.className).toContain('size-9')
```

在 `TransferPanel.test.tsx` 的移除按钮断言后加入：

```tsx
expect(removeButton.className).toContain('size-9')
```

- [ ] **Step 2: 运行消费者测试确认旧实现失败**

运行：

```text
bun run --cwd apps/web test -- src/components/IncomingFileRequestDialog.test.tsx src/components/TransferPanel.test.tsx
```

预期：尺寸断言失败，因为现有三个 action 仍为 `size-11`。

- [ ] **Step 3: 修改复制、下载、移除 action 的尺寸**

将 `IncomingFileRequestDialog.tsx` 中复制按钮和下载链接的 class 从 `size-11` 改为 `size-9`，并将图标内联样式改为：

```tsx
style={{ fontSize: '15px' }}
```

将 `TransferPanel.tsx` 中移除按钮的 `size-11` 改为 `size-9`，图标样式从 16px 改为：

```tsx
style={{ fontSize: '15px' }}
```

保留 `rounded-lg`、`shrink-0`、hover/focus class、`onClick`、`event.stopPropagation()`、下载属性和 ARIA 标签。

- [ ] **Step 4: 运行消费者测试确认通过**

运行：

```text
bun run --cwd apps/web test -- src/components/IncomingFileRequestDialog.test.tsx src/components/TransferPanel.test.tsx
```

预期：相关测试全部通过，复制、下载、移除和传输状态变化没有回归。

- [ ] **Step 5: 提交 Task 2**

```text
git add apps/web/src/components/IncomingFileRequestDialog.tsx apps/web/src/components/IncomingFileRequestDialog.test.tsx apps/web/src/components/TransferPanel.tsx apps/web/src/components/TransferPanel.test.tsx
git commit -m "fix(web): compact file row action buttons"
```

### Task 3: 完整质量验证与本地回归

**Files:**
- No source changes expected; only test/build artifacts may be generated outside committed source files.

**Interfaces:**
- Consumes: Task 1 的 `pr-12` 内容预留和 Task 2 的 `size-9` action。
- Produces: 通过单元测试、构建和真实浏览器传输验证的紧凑文件列表 UI。

- [ ] **Step 1: 检查补丁和工作树**

运行：

```text
git diff --check
git status --short
```

预期：没有空白错误，工作树只包含当前任务预期改动或已提交后保持干净。

- [ ] **Step 2: 运行 Web 质量门禁**

运行：

```text
bun run --cwd apps/web lint
bun run --cwd apps/web test
bun run --cwd apps/web typecheck
bun run --cwd apps/web build
```

预期：lint、全部 Web 单元测试、typecheck 和 build 全部通过。

- [ ] **Step 3: 运行完整仓库验证和真实浏览器 E2E**

运行：

```text
bun run verify
bun run e2e
```

预期：API、Web、contracts 的 lint/test/typecheck/build 全部通过，真实浏览器文件传输 E2E 全部通过。

- [ ] **Step 4: 复核样式契约和提交记录**

检查：

```text
git diff --check
git status --short
git log -5 --oneline
```

确认文件行 action 使用 `size-9`，有 action 的内容层使用 `pr-12`，底部主操作仍保持原尺寸，然后向用户说明刷新页面即可看到结果。

## Plan self-review

- Spec coverage: 36px 尺寸、15px 图标、`pr-12`、矩形圆角、主操作不变、交互不变和完整验证均有对应任务。
- Placeholder scan: 计划没有占位标记或模糊步骤；每个代码改动都有具体文件、代码内容、命令和预期结果。
- Type consistency: `FileTransferRow` 接口不变，button/anchor 类型和现有回调保持一致，没有新增接口。
