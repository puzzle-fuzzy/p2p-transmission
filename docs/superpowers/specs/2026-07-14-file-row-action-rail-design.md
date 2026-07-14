# 文件传输行操作栏矩形化设计

日期：2026-07-14

状态：已确认，待实施

## 背景

`FileTransferRow` 使用一层绝对定位的进度填充显示传输进度，右侧的复制、下载或移除操作位于更高的层级。当前操作按钮使用 `rounded-full`，且接收文件对话框中的复制/下载按钮会覆盖在矩形进度填充之上，导致文件行同时出现矩形进度条和圆形 hover 背景，视觉边界不一致。

## 目标

1. 保留进度层覆盖整行的实现和现有进度语义。
2. 将文件行右侧操作区表现为文件行的一部分，而不是独立的圆形浮层。
3. 复制、下载、移除按钮改为矩形圆角 hover 背景。
4. 保持现有按钮尺寸、点击行为、键盘交互和 ARIA 标签。
5. 让操作区的右侧圆角与文件行外层 `rounded-lg` 对齐。

## 非目标

- 不修改进度计算、进度事件调度或文件传输协议。
- 不改变复制、下载、移除按钮的业务行为和文字/ARIA 标签。
- 不移除操作区对进度层的覆盖关系；操作区仍需保证图标在深色背景上可读。
- 不引入新的组件库、阴影、渐变或额外动画。

## 方案

### 文件行结构

`FileTransferRow` 保持三层结构：

1. 外层行：`relative overflow-hidden rounded-lg bg-white/5`。
2. 进度层：继续使用 `absolute inset-y-0 left-0`，宽度由百分比控制。
3. 内容层和操作层：内容层保持 `relative z-10`，操作层保持 `absolute inset-y-0 right-0 z-20`。

操作层增加 `rounded-r-lg`，并保留深色 surface 背景，使操作区成为右侧矩形 rail，同时自然裁切进度层的最右侧。

### 操作按钮

涉及文件行的复制、下载、移除按钮统一使用 `rounded-lg`，不再使用 `rounded-full`。按钮仍保持 `size-11` 或等价的 44px 最小触控区域，hover/focus 只改变背景或文字颜色，不改变按钮几何形状。

具体范围：

- `apps/web/src/components/IncomingFileRequestDialog.tsx`：复制和下载按钮。
- `apps/web/src/components/TransferPanel.tsx`：移除按钮。
- `apps/web/src/components/FileTransferRow.tsx`：通用操作层的右侧圆角。

### 交互与可访问性

复制、下载和移除的事件处理保持不变。现有 `aria-label`、键盘可聚焦行为、`focus-visible` 样式和点击冒泡控制保持不变。此次调整只改变视觉容器和圆角，不改变文件状态或传输生命周期。

## 测试策略

- `FileTransferRow.test.tsx` 验证通用操作层包含 `rounded-r-lg`，进度层仍保持 `bg-accent/15` 和进度语义。
- `IncomingFileRequestDialog.test.tsx` 更新复制/下载按钮的几何样式断言，确认按钮使用 `rounded-lg`，并继续验证下载与复制行为。
- `TransferPanel.test.tsx` 如有操作按钮样式断言，同步确认移除按钮为 `rounded-lg`；现有移除行为测试继续通过。
- 运行 Web 聚焦测试、Web lint、typecheck、build 和完整 E2E，确保视觉调整没有影响传输行为。

## 验收标准

- 文件行右侧不再出现 `rounded-full` 的复制、下载或移除 hover 背景。
- 文件行右侧操作区与外层文件行共享矩形形状，并保留右侧圆角。
- 鼠标移入操作按钮时，背景仍然明显可见，但不会呈现圆形。
- 进度条仍能正确显示 0% 到 100%，ARIA `progressbar` 语义和数值不变。
- 所有相关测试和完整验证通过。

## 用户确认

用户已确认采用“矩形右侧操作栏 + 矩形圆角按钮”方案。
