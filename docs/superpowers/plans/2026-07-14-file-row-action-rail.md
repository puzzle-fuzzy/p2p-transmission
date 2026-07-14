# 文件传输行操作栏矩形化实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复文件传输行右侧操作层的圆形 hover 视觉，使进度条、操作栏和文件行保持一致的矩形圆角形状。

**Architecture:** 保持 `FileTransferRow` 的进度层、内容层和操作层的现有绝对定位关系，只把操作层的右边界与外层文件行对齐。所有复制、下载、移除按钮仅改变圆角 class，不改变 props、事件、ARIA 或文件传输状态。

**Tech Stack:** React 19、TypeScript、Tailwind CSS v4、Vitest、Testing Library、Bun 1.3.14。

## Global Constraints

- 进度层继续使用整行绝对定位和百分比宽度，不能修改进度计算或协议。
- 文件行操作区必须使用与外层一致的矩形右侧圆角，不再呈现独立圆形浮层。
- 复制、下载、移除按钮改为 `rounded-lg`，保持 `size-11` 或等价的 44px 触控区域。
- 现有点击行为、键盘交互、ARIA 标签、focus-visible 反馈和事件冒泡控制必须保持不变。
- 不引入新的组件库、阴影、渐变或额外动画。
- 使用项目锁定的 Bun 版本运行测试、lint、typecheck、build 和 E2E。

---

### Task 1: 统一 FileTransferRow 操作栏右侧形状

**Files:**
- Modify: `apps/web/src/components/FileTransferRow.test.tsx:27-42`，增加操作栏右侧圆角断言。
- Modify: `apps/web/src/components/FileTransferRow.tsx:120-126`，给通用操作层增加 `rounded-r-lg`。

**Interfaces:**
- Consumes: 现有 `FileTransferRowProps.action?: ReactNode` 和进度层/内容层 DOM 结构。
- Produces: 相同的 `FileTransferRow` props 与 DOM 行为；操作层继续由 `data-testid=file-transfer-action-${fileId}` 暴露。

- [ ] **Step 1: 添加操作栏形状失败断言**

在现有 `FileTransferRow.test.tsx` 的 action slot 断言后添加：

```tsx
expect(actionSlot.className).toContain('rounded-r-lg')
```

- [ ] **Step 2: 运行聚焦测试，确认旧实现失败**

运行：

```text
bun run --cwd apps/web test -- src/components/FileTransferRow.test.tsx
```

预期：测试失败，因为当前 action slot 没有 `rounded-r-lg`。

- [ ] **Step 3: 实现操作栏右侧圆角**

将 `FileTransferRow.tsx` 中的 action slot class 从：

```tsx
className="absolute inset-y-0 right-0 z-20 flex items-center"
```

改为：

```tsx
className="absolute inset-y-0 right-0 z-20 flex items-center rounded-r-lg"
```

保持具体操作内容的背景由调用方决定，不改变进度层、内容层或 action ReactNode。

- [ ] **Step 4: 运行聚焦测试，确认通用结构通过**

运行：

```text
bun run --cwd apps/web test -- src/components/FileTransferRow.test.tsx
```

预期：2 个测试全部通过，进度 ARIA 数值与 `bg-accent/15` 断言保持通过。

- [ ] **Step 5: 提交通用操作栏变更**

```text
git add apps/web/src/components/FileTransferRow.tsx apps/web/src/components/FileTransferRow.test.tsx
git commit -m "fix(web): align file row action rail"
```

### Task 2: 将复制、下载和移除按钮改为矩形圆角

**Files:**
- Modify: `apps/web/src/components/IncomingFileRequestDialog.tsx:275-301`，将接收文件操作栏对齐到右侧圆角并将复制/下载按钮改为 `rounded-lg`。
- Modify: `apps/web/src/components/IncomingFileRequestDialog.test.tsx:205-215`，断言复制/下载按钮不再使用 `rounded-full`。
- Modify: `apps/web/src/components/TransferPanel.tsx:297-309`，将移除按钮改为 `rounded-lg`。
- Modify: `apps/web/src/components/TransferPanel.test.tsx:345-348`，增加移除按钮几何样式断言。

**Interfaces:**
- Consumes: Task 1 的 `FileTransferRow` 操作栏右侧圆角；现有 `copyFileContent`、download anchor 和 `onFileRemoved` 行为。
- Produces: 复制、下载和移除仍是原来的 button/anchor，仍使用 `size-11`、ARIA label 和点击回调。

- [ ] **Step 1: 先添加消费者按钮样式失败断言**

在 `IncomingFileRequestDialog.test.tsx` 中将现有下载断言改为：

```tsx
expect(firstDownload.className).toContain('rounded-lg')
expect(firstDownload.className).not.toContain('rounded-full')
```

并给文本文件复制按钮增加：

```tsx
const copyTextFile = screen.getByRole('button', { name: '复制说明.txt 的内容' })
expect(copyTextFile.className).toContain('rounded-lg')
expect(copyTextFile.className).not.toContain('rounded-full')
```

在 `TransferPanel.test.tsx` 中，将现有移除按钮获取改为保留引用并增加：

```tsx
const removeButton = screen.getByRole('button', { name: '移除 progress.bin' })
expect(removeButton.className).toContain('rounded-lg')
expect(removeButton.className).not.toContain('rounded-full')
```

- [ ] **Step 2: 运行消费者测试，确认旧样式按预期失败**

运行：

```text
bun run --cwd apps/web test -- src/components/IncomingFileRequestDialog.test.tsx src/components/TransferPanel.test.tsx
```

预期：下载、复制和移除按钮的 `rounded-lg` 断言失败，旧实现仍包含 `rounded-full`。

- [ ] **Step 3: 修改三个消费者的视觉 class**

在 `IncomingFileRequestDialog.tsx` 中将操作栏调整为：

```tsx
<div className="flex items-center gap-0.5 rounded-r-lg bg-surface-elevated/95 pl-0.5">
```

并将复制按钮和下载链接中的 `rounded-full` 替换为 `rounded-lg`，保留 `size-11` 和所有其他 class。

在 `TransferPanel.tsx` 中仅将移除按钮 class 中的 `rounded-full` 替换为 `rounded-lg`，不修改 `event.stopPropagation()` 和 `onFileRemoved(selection.fileId)`。

- [ ] **Step 4: 运行消费者测试，确认视觉和行为通过**

运行：

```text
bun run --cwd apps/web test -- src/components/IncomingFileRequestDialog.test.tsx src/components/TransferPanel.test.tsx
```

预期：接收文件对话框和发送面板测试全部通过，复制/下载/移除的既有交互断言不回归。

- [ ] **Step 5: 提交按钮样式变更**

```text
git add apps/web/src/components/IncomingFileRequestDialog.tsx apps/web/src/components/IncomingFileRequestDialog.test.tsx apps/web/src/components/TransferPanel.tsx apps/web/src/components/TransferPanel.test.tsx
git commit -m "fix(web): square file row action hover states"
```

### Task 3: 完整验证视觉修复没有影响传输行为

**Files:**
- No source changes expected; verification should only produce test artifacts outside the committed source tree.

**Interfaces:**
- Consumes: Task 1 的操作栏几何结构和 Task 2 的复制/下载/移除样式。
- Produces: 通过完整质量门禁和真实浏览器传输验证的文件行 UI。

- [ ] **Step 1: 检查最终补丁格式和工作树**

运行：

```text
git diff --check
git status --short
```

预期：没有空白错误；工作树只包含当前任务预期的未提交内容，或在任务提交后保持干净。

- [ ] **Step 2: 运行 Web 完整质量门禁**

运行：

```text
bun run --cwd apps/web lint
bun run --cwd apps/web test
bun run --cwd apps/web typecheck
bun run --cwd apps/web build
```

预期：lint、全部 Web 单元测试、typecheck 和 production build 全部通过。

- [ ] **Step 3: 运行完整仓库验证和真实浏览器 E2E**

运行：

```text
bun run verify
bun run e2e
```

预期：API、Web、contracts 的 lint/test/typecheck/build 全部通过，真实浏览器文件传输 E2E 全部通过。

- [ ] **Step 4: 复核文件行样式与提交记录**

检查：

```text
git diff --check
git status --short
git log -5 --oneline
```

确认 `FileTransferRow` 的进度层仍是矩形铺满，操作层有 `rounded-r-lg`，复制/下载/移除按钮没有 `rounded-full`，然后向用户说明完成结果和本地刷新方式。

## Plan self-review

- Spec coverage: 操作层结构、右侧圆角、按钮几何、44px 触控区域、交互保持、进度 ARIA、测试和完整验证均有任务覆盖。
- Placeholder scan: 计划未使用占位标记或模糊的“以后处理”描述；每个修改步骤都提供了实际文件、class、测试命令和预期结果。
- Type consistency: `FileTransferRowProps.action`、现有 button/anchor 类型、回调和 ARIA label 均保持不变；没有引入新的接口。
