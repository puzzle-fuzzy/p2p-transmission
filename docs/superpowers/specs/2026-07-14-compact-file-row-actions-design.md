# 紧凑文件行操作按钮设计

日期：2026-07-14

状态：已确认，待实施

## 背景

文件列表中的复制、下载和移除 action 当前使用 `size-11`，即 44×44px。接收文件行同时显示复制和下载时，右侧操作区占用约 88px 宽度，导致文件列表显得拥挤。用户希望文件列表 action 的宽高都进一步缩小。

## 目标

1. 将文件列表中的复制、下载和移除按钮统一缩小为 36×36px。
2. 将对应图标从 17px/16px 收紧到约 15px，保持图标清晰。
3. 同步减少文件行内容右侧预留空间，让文件名和元数据获得更多空间。
4. 保留矩形圆角 action rail、现有 hover/focus 反馈和原有业务行为。
5. 不改变底部“一键下载”、关闭、接收等主操作按钮的尺寸。

## 非目标

- 不修改文件传输协议、进度计算、传输状态或下载/复制逻辑。
- 不修改接收对话框和发送面板之外的其他圆形 icon button。
- 不调整 Toast、弹窗整体尺寸或页面其他布局。
- 不引入新的响应式断点、组件库或 CSS 动画。

## 方案

### 文件行尺寸

`FileTransferRow` 的内容层在有 action 时从 `pr-14` 收紧为 `pr-12`，无 action 时继续使用 `pr-3`。进度层、内容层和右侧 action rail 的定位关系保持不变。

文件列表 action 统一使用：

- `size-9`，即 36×36px；
- `rounded-lg`，与当前矩形操作风格一致；
- 复制、下载图标使用 15px；移除图标使用 15px；
- action rail 继续使用 `rounded-r-lg`。

### 触控与交互

这次调整明确接受文件列表 action 点击区域从 44px 缩小到 36px，以优先满足文件列表的紧凑布局。按钮仍然保持可聚焦、可键盘操作、拥有清晰的 hover/focus 反馈和现有 ARIA 标签。

底部主操作不变：一键下载、关闭、接收全部、取消接收仍保持当前 `min-h-11` 尺寸。

## 涉及组件

- `apps/web/src/components/FileTransferRow.tsx`：收紧有 action 时的内容右内边距。
- `apps/web/src/components/IncomingFileRequestDialog.tsx`：复制/下载 action 使用 `size-9` 和 15px 图标。
- `apps/web/src/components/TransferPanel.tsx`：移除 action 使用 `size-9` 和 15px 图标。

## 测试策略

- `FileTransferRow.test.tsx` 验证有 action 时使用 `pr-12`，无 action 仍使用 `pr-3`。
- `IncomingFileRequestDialog.test.tsx` 验证复制与下载按钮使用 `size-9`，并继续验证 `rounded-lg`、链接属性和复制按钮存在性。
- `TransferPanel.test.tsx` 验证移除按钮使用 `size-9`、`rounded-lg`，并继续验证传输状态变化后移除按钮消失。
- 运行 Web 聚焦测试、lint、typecheck、build、完整 verify 和真实浏览器 E2E。

## 验收标准

- 文件列表中的复制、下载、移除 action 均为 36×36px。
- 接收文件行的双 action 区域明显比当前 44px 版本紧凑，文件名和文件大小不会被不必要地挤压。
- hover 时保持矩形圆角，不恢复为圆形。
- 文件内容复制、单文件下载、批量下载、移除文件和传输状态均不回归。
- 所有相关测试和完整验证通过。

## 用户确认

用户已确认采用 `size-9`（36×36px）紧凑 action 方案。
