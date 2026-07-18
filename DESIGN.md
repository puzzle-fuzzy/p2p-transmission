---
name: P2P Transmission
description: 快速、极简、可靠的 P2P 文件传输工具
colors:
  primary: "#5e11d1"
  bg: "#2d2d2d"
  surface-elevated: "rgba(255,255,255,0.05)"
  ink: "rgba(255,255,255,0.8)"
  ink-muted: "rgba(255,255,255,0.56)"
  ink-dim: "rgba(255,255,255,0.2)"
  border: "rgba(255,251,235,0.15)"
  control-border: "rgba(255,251,235,0.36)"
  border-dashed: "rgba(255,251,235,0.15)"
typography:
  body:
    fontFamily: "system-ui, -apple-system, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "system-ui, -apple-system, sans-serif"
    fontSize: "12px"
    fontWeight: 400
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, monospace"
    fontSize: "20px"
    fontWeight: 400
rounded:
  sm: "8px"
  md: "12px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  xxl: "32px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "12px 64px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.ink-muted}"
    rounded: "{rounded.md}"
    padding: "12px 64px"
  tab-active:
    backgroundColor: "rgba(255,255,255,0.10)"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "10px 16px"
  tab-inactive:
    backgroundColor: "transparent"
    textColor: "{colors.ink-dim}"
    rounded: "{rounded.sm}"
    padding: "10px 16px"
  input-field:
    backgroundColor: "transparent"
    borderColor: "{colors.control-border}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "16px"
---
<!-- SEED: 当前产品仅提供深色主题。浅色模式不是当前承诺，仅作为未来可选方向评估。 -->

# Design System: P2P Transmission

## 1. Overview

**Creative North Star: "The Dark Workshop"**

一个专注于传东西的工具——没有账户、没有云存储、没有多余步骤。设计系统从"工作台"的隐喻出发：深色背景让前方的内容成为视觉焦点，紫色信号点明正在发生的连接和传输。每个界面只有一个核心操作，控件退后，信息前进。

页面的气质是"工具式的克制"：平坦、不堆叠、不炫技。圆角微乎其微（12px 封顶），阴影不出现，层次通过透明度的微妙变化来区分。用户看到的不是设计，而是传输任务本身。

**Key Characteristics:**
- 深色背景 + 单色阶调，不做多色分层
- 无阴影，无毛玻璃，无渐变
- 内容居中的单栏布局，视口即是容器
- 间距规整，以 4px 为步进基数的对称尺度
- 所有交互反馈仅通过颜色和透明度的变化表达

## 2. Colors

深色底 + 紫色信号 + 白色半透明阶调，构成三层的色彩体系。

### Primary

- **Signal Purple** (`#5e11d1`): 信号色。用在按钮填充、输入框聚焦边框、进度指示、完成标记。在深色背景上它是唯一有彩色，因此它的出现本身就传达"交互正在发生"或"操作可执行"。

### Neutral

- **Charcoal** (`#2d2d2d`): 主背景色。全页的画布色，无纹理无渐变。
- **Surface Elevated** (`rgba(255,255,255,0.05)`): 浅浮层底色。用于 Tab 背景、文件行、按钮悬浮时极淡的提亮。与背景的区分刚刚好能感知。
- **Tab Active** (`rgba(255,255,255,0.10)`): Tab 选中态的底色，比表面层略亮一级。
- **Ink** (`rgba(255,255,255,0.80)`): 正文颜色。标题、输入文本、按钮文字。
- **Ink Muted** (`rgba(255,255,255,0.56)`): 次要文字。文件描述、日志内容、辅助提示。
- **Ink Dim** (`rgba(255,255,255,0.20)`): 禁用和装饰文字。分割线文字、占位符、时间戳。
- **Border** (`rgba(255,251,235,0.15)`): 结构描边色。分割线、按钮轮廓和非必要边界。
- **Control Border** (`rgba(255,251,235,0.36)`): 输入控件的默认可见边界；在 Charcoal 上达到至少 3:1，满足 WCAG 2.2 AA 非文本对比度。

### Named Rules

**The One Color Rule.** Signal Purple 是唯一的彩色，只出现在交互元素（按钮、聚焦、进度、完成标记）上。它的稀有度就是它的意义。不要将它用在纯装饰元素上。

**The Opacity Scale Rule.** 层次不靠阴影，靠白色叠加的透明度阶梯：5% → 10% → 15% → 56% → 80%。每跳对应一个语义角色。输入控件边界使用 36% 作为非文本对比度例外；Signal Purple 的进度/选中表面使用 22%，确保背景进度在深色表面上清楚可辨。

## 3. Typography

**Body Font:** system-ui, -apple-system, sans-serif
**Mono Font:** ui-monospace, SFMono-Regular, monospace（仅验证码输入）

**Character:** 一套无衬线走到底。不需要字体堆叠来表现个性——字重和字号对比承担全部层级工作。正文 14px、标签 12px，步进克制，不追求戏剧化。

### Hierarchy

- **Body** (400, 14px, 1.5): 默认正文。按钮文字、Tab 标签、文件名称。
- **Label** (400, 12px): 辅助信息。日志内容、文件大小、字数统计、分割线文字。
- **Mono** (400, 20px): 仅用于验证码 6 位输入框。等宽保证数字对齐。
- **Button** (400, 14px, `0.05em` letter-spacing): 按钮文字。小写字母 + 微小字距，克制而不松散。

### Named Rules

**The Flat Hierarchy Rule.** 不使用超出 16px 的正文或小于 12px 的标签。字号梯度只有 12 → 14 → 20（等宽）三级。不引入 display / headline 等大字号层级——这个系统不需要。

## 4. Elevation

该设计系统是**纯平**的。没有任何 `box-shadow`、`drop-shadow`、或模糊叠加。

深度通过透明度的阶梯来表达：背景（0%）→ 表面层（5% 白色）→ Tab 选中（10% 白色）→ 描边（15%）。这个序列覆盖了全部层次需求。如果某个元素需要"浮起"，提亮其表面层的透明度即可，不要加阴影。

### Named Rules

**The Flat-By-Default Rule.** 所有表面在静止状态下都是平的。没有任何元素自带阴影。阴影的出现永远是错误。

## 5. Components

### Buttons

- **Shape:** 轻微圆角 (12px)。无阴影，无边框（填充态）。文字小写 + 0.05em 字距。
- **Primary（Signal Purple 填充）:** `bg: #5e11d1` `text: rgba(255,255,255,0.9)` `padding: 12px 64px`。hover 时 `brightness(1.1)`，active 时 `brightness(0.9)`。色彩变化是唯一的反馈。
- **Ghost（描边）:** `bg: transparent` `border: 1px solid rgba(255,251,235,0.15)` `text: rgba(255,255,255,0.5)`。hover 时背景变为 `rgba(255,255,255,0.05)`，文字提亮。

### Tabs

- **Shape:** 8px 圆角的药丸容器（容器本身 12px 圆角）。
- **Container:** 白色 5% 透明度为底，`p-1` (4px) 内边距。
- **Active Tab:** `bg: rgba(255,255,255,0.10)` `text: rgba(255,255,255,0.80)`。
- **Inactive Tab:** `bg: transparent` `text: rgba(255,255,255,0.40)`，hover 提亮。
- 无底部指示条，无图标。激活态靠背景色区分。

### Inputs / Fields

- **Style:** 透明背景 + 1px 可见控件描边 ( `rgba(255,251,235,0.36)` )，12px 圆角。
- **Textarea:** 同输入框风格，内边距 16px，右下角字数统计。
- **Focus:** 描边切换至 Signal Purple (`#5e11d1`)。无发光、无偏移、无动画外的额外反馈。
- **Verification Code（六位）:** 六个独立等宽输入框，每个 `w-12 h-14`，`font-mono` (20px)，居中文字。支持粘贴分发和自动跳格。

### File Drop Zone

- **Shape:** 12px 圆角容器，2px 虚线描边 (`rgba(255,251,235,0.15)`)。无文件时为居中上传提示，有文件时顶部排列。
- **File Item:** 8px 圆角行，白色 5% 透明度底。选中后点击"传输"，行内背景以 Signal Purple 22% 透明度从左向右填充表示进度，并同时显示文字状态。完成后文件图标变为紫色对勾。
- **"添加更多文件"** 底部居中，以 `+` 图标 + 文字呈现。

### Log Entries

- **Style:** 纯文本，无背景无容器。时间戳 + 消息体平铺，两列布局。
- **Timestamp:** 12px，`tabular-nums`，ink-dim (20%) 透明度。
- **Message:** 12px，ink-muted (56%) 透明度。
- **Pending Indicator:** 消息以 `…` 结尾时，右侧显示旋转圆环（12px SVG，1s 周期线性旋转，颜色同 ink-muted）。

## 6. Do's and Don'ts

### Do:

- **Do** 使用 Signal Purple 作为唯一的交互色——按钮填充、焦点边框、进度条、完成对勾。
- **Do** 使用透明度阶梯（5% / 10% / 15% / 56% / 80%）区分层次；仅为非文本对比度使用 36% 控件边界、为进度/选中表面使用 22% Signal Purple，不要用阴影或渐变。
- **Do** 保持 12px 圆角上限：大容器、按钮、输入框用 12px，内部元素（Tab、文件行）用 8px。
- **Do** 让每个页面只有一个核心操作。Tab 选中态靠背景色区分，不需要底部指示条。
- **Do** 使用 CSS 变量维护深色体系的语义一致性。浅色映射仅在未来需求明确后补充，不属于当前实现要求。

### Don't:

- **Don't** 使用赛博朋克风格：霓虹色、故障效果、暗黑过载背景。
- **Don't** 花里胡哨：装饰性元素、不必要的动画、过度设计。
- **Don't** 像 Telegram 那样：功能密集的侧栏、多层导航、视觉过载。
- **Don't** 制造复杂：不到三步能完成的操作，不要做成配置向导。
- **Don't** 使用阴影——任何 `box-shadow` 或 `drop-shadow` 都是错误。
- **Don't** 使用边框以外的装饰手法：`border-left` 色条、`background-clip: text` 渐变文字、`backdrop-filter` 毛玻璃。
- **Don't** 引入第二个有彩色。Signal Purple 是唯一的主色，不使用次级/三级色。
