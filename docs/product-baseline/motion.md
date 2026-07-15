# 动效基线

## 动效参数

| 名称 | 触发 | 当前表现 | 2.0 约束 |
| --- | --- | --- | --- |
| `receiver-avatar-enter` | 新接收者进入 | opacity 0→1、scale 0.68→1、360ms | 每个新 peer 只触发一次 |
| `avatar-ripple` | 活跃连接头像 | 两层扩散、2.4s、错开 1.2s | 不遮挡内容、不接收点击 |
| `dot-wave` | connecting/requesting | 三点缩放/透明度、1.2s、120ms 错峰 | 只表达等待，不无限掩盖错误 |
| `transfer-dash-flow` | transferring | dash offset、800ms linear | 不引发布局或高频重渲染 |
| `flow-state-enter` | complete/error icon | opacity + scale、180ms | 状态文本同步更新 |
| `file-row-enter` | 文件加入列表 | opacity + translateY 4px、180ms | 批量加入不造成明显卡顿 |
| `dialog-enter` | dialog 打开 | opacity + scale 0.98、160ms | 焦点在动画开始时已正确设置 |
| `scrim-enter` | dialog backdrop | opacity、160ms | 不闪烁 |
| `toast-enter` | toast 出现 | translateY -6px + scale 0.98、160ms | 不抢焦点 |
| `toast-timer` | toast 自动关闭 | scaleX 1→0、3200ms | 与真实关闭时间一致 |

## Reduced motion

`prefers-reduced-motion: reduce` 下：

- 关闭头像 ripple、dot wave、dash flow、缩放进入和位移动画。
- 状态、进度和错误仍立即可见。
- 不通过仅靠动画传达新的接收者、完成或错误。

## 性能原则

- 主要动画只使用 `transform` 和 `opacity`。
- 文件字节进度按 animation frame 合并，不给每个 DataChannel chunk 触发一次完整渲染。
- 终止状态可以短暂保留，但不能用定时器覆盖用户开始的新传输。
