# 无障碍基线

## 语义

- 页面只有一个主要 `h1`，dialog 标题层级连续。
- 房间码输入使用 group 和六个可区分的 accessible name。
- PeerFlow 使用 `role=status`、`aria-live=polite` 和原子化状态文本。
- 错误使用 alert 或等价的及时反馈；普通进度不使用会刷屏的 assertive live region。
- 图标按钮必须有 accessible name；装饰图标 `aria-hidden`。

## 键盘与焦点

- 所有按钮、链接、房间码输入、文件选择和接收者选择可用键盘完成。
- `focus-visible` 清晰，不能只靠颜色极轻的变化。
- dialog 打开后焦点进入 dialog，Tab 不离开，Escape 可关闭时有效。
- dialog 关闭后焦点返回原触发控件。
- 文件拖拽区同时是可键盘激活的按钮，不要求用户必须拖拽。

## 触控与响应式

- 主要交互最小高度约 44px。
- 390px viewport 不出现横向页面滚动。
- dialog 在小屏有内部滚动，关闭按钮始终可找到。
- 200% 缩放下文本不截断关键动作。

## 动效与颜色

- 遵守 `prefers-reduced-motion`。
- 连接、完成和错误不能只依赖颜色区分。
- 文本、边框、focus ring 和禁用态在暗色背景上保持可辨识对比。
