---
name: Vault
description: 安静、可信、跨设备的端到端加密文件与文本传输空间
colors:
  mist-accent: "#687f73"
  slate-accent: "#668095"
  dusk-accent: "#91acaa"
  sand-accent: "#988b73"
  surface: "rgba(255,255,255,0.72)"
  surface-dark: "rgba(39,43,46,0.86)"
typography:
  display: "Georgia, 'Times New Roman', serif"
  body: "'Segoe UI', 'Microsoft YaHei', system-ui, sans-serif"
  mono: "'Cascadia Mono', Consolas, monospace"
rounded:
  control: "8px"
  surface: "14px"
motion:
  fast: "160ms"
  panel: "480ms cubic-bezier(0.22, 1, 0.36, 1)"
---

# Design System: Vault

## 1. Creative North Star

**Quiet confidence.** Vault 是一间安静、可靠的临时传输室，而不是功能密集的网盘。界面用大量留白、克制的玻璃表面、衬线标题和细密的状态反馈，让“房间、成员、传输”三件事一眼可见。

产品承诺保持不变：不要求账户，正文不会写入应用服务器；房间只负责连接双方，文件与文本经 WebRTC 加密通道传输。原型中的假成员、随机进度和模拟活动不得进入生产实现。

## 2. Theme Architecture

界面提供四套等价主题，并通过语义变量保持组件结构一致：

- **Mist**：雾白背景与鼠尾草绿，默认主题；温和、可信。
- **Slate**：冷灰蓝，强调工具感和清晰度。
- **Dusk**：深炭黑表面与低饱和青灰，高对比暗色主题。
- **Sand**：暖米白与灰褐色，适合更柔和的阅读环境。

每套主题支持三种背景气氛：Quiet 柔光、Paper 纸雾、Plain 纯色。主题和壁纸只改变语义 token，不改变布局。偏好写入浏览器本地存储，并在首屏脚本中提前应用，避免闪烁。

主要语义 token：

- `--bg` / `--bg-secondary`：页面基底与环境光。
- `--glass-surface` / `--surface-solid`：主卡片与模态框表面。
- `--text-primary` / `--text-muted` / `--text-faint`：三层文字层级。
- `--accent` / `--accent-faint`：主要操作、在线状态与选择反馈。
- `--border` / `--border-faint`：控件边界与结构分隔。
- `--shadow` / `--scrim`：浮层深度与模态遮罩。

## 3. Typography

- **Brand / display**：Georgia 或 Times New Roman。用于 VAULT 标识、房间标题与主要面板标题，字重 600，保持文学性但不装饰化。
- **Product UI**：Segoe UI / Microsoft YaHei / system-ui。用于正文、按钮、状态和操作说明。
- **Code**：Cascadia Mono / Consolas。仅用于六位房间码和需要逐位对齐的短标识。
- 品牌标识使用大写与较宽字距；正文不使用全大写。
- 正文最小 12px；核心操作文字 14px；标题 20–24px。长说明保持 1.65–1.75 行高。

## 4. Layout

### Shared Shell

所有非启动页面共享同一结构：品牌头部、单一玻璃卡片、产品能力列表、隐私说明和页脚链接。桌面内容宽度上限为 960px；移动端使用 16px 页面边距。

### Lobby

桌面为等宽双栏：左侧输入六位房间码，右侧创建房间。中线只承担结构分隔。移动端改为单列，并用带“或”的横向分隔符说明两个入口互斥。

### Room

房间卡片由两部分组成：

1. 顶部状态栏：房间码、分享、点对点连接状态、在线人数、角色、离开。
2. 工作区：主传输列 + 300px 成员与活动列。小屏幕下改为单列，成员区位于传输区之后。

成员和活动必须来自当前权威快照、WebRTC 状态和真实传输状态。离开房间必须二次确认。

## 5. Components

### Verification Code

六个独立输入格，支持逐位输入、粘贴分发、自动前进与无障碍名称。焦点使用 `--accent` 轮廓；错误同时提供文字，不只依赖颜色。

### Buttons

- Primary：实色 `--accent`，高对比文字，8px 圆角。
- Secondary：透明或浅表面，1px 语义边框。
- Icon button：最小 40×40px 点击区域，必须提供可见 tooltip 或 `aria-label`。
- 禁用态保留清晰轮廓，不允许只靠低透明度消失。

### File Selection

文件入口使用大面积虚线区域表达“选择文件”，但仍调用项目已有的持久文件选择器，保留批量选择、恢复和大文件直接写盘能力。不要伪装成浏览器不支持的拖放能力。

### Member Roster and Activity

成员头像沿用确定性 identicon；明确标出“你”、发送者/接收者和在线状态。活动记录以真实连接、协商、传输、校验结果生成，不写入虚构时间线。

### Dialogs

外观、分享、加入审批、接收请求、离开确认都使用原生 `dialog`。打开时聚焦，Escape 可关闭非破坏性流程；危险或中断性操作需明确确认文案。

## 6. Motion

- 页面/面板进入：轻微纵向位移与透明度变化，480ms，使用平滑减速曲线。
- 按钮与卡片 hover：160–220ms，只改变颜色、边界、阴影或 1px 位移。
- 在线状态与新成员：短促淡入或脉冲，不能持续抢夺注意力。
- 所有动画在 `prefers-reduced-motion: reduce` 下关闭或缩短为近即时反馈。
- 不使用滚动劫持、循环装饰动画或假传输进度。

## 7. Responsive and Accessibility

- 800px 以下将双栏布局折叠为单列；520px 以下压缩房间顶部状态并让操作自然换行。
- 触摸目标不小于 40×40px；键盘焦点必须清晰可见。
- 所有主题的正文、控件边界和状态色都应满足 WCAG 2.2 AA。
- 状态变化用 `role=status` / `aria-live`；错误用 `role=alert`。
- 不用图标独自表达关键动作；“离开”等高影响操作同时显示文字。

## 8. Product Boundaries

- Do：保持创建/加入两条最短路径；把连接、成员、传输状态放在同一视野；让隐私承诺可见。
- Do：复用现有会话恢复、多人接收、文件批次、文本传输和 BLAKE3 校验能力。
- Don't：引入账户、云端文件库、营销导航或多层配置向导。
- Don't：为了贴近视觉原型而削弱 Origin 校验、邀请能力、服务端权限或持久文件句柄策略。
- Don't：使用随机成员、随机日志、模拟进度或会误导用户的拖放文案。
