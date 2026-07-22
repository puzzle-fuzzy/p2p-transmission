---
name: 点对点传输
description: 按本地 P2P Delivery 原型复刻的 Swiss Editorial 临时文件传输界面
colors:
  background: #f7f7f2
  panel: #efefea
  text: #111111
  muted: #76766f
  line: #d7d7d0
  blue: #123db5
typography:
  body: Helvetica Neue, PingFang SC, Noto Sans SC, Arial, sans-serif
  mono: SFMono-Regular, IBM Plex Mono, Menlo, Consolas, monospace
layout:
  desktop: asymmetric editorial grid, blue host panel and grey join panel
  mobile: single-column stacked panels with full-width actions
motion:
  interaction: 160ms ease
---

# Design System: P2P Delivery

## 1. 参考来源

页面视觉以 `R:/zip/p2p-delivery-responsive/p2p-delivery-responsive/index.html`、`styles.css` 和 `app.js` 为唯一参考：

- 纸灰背景 `#f7f7f2`，黑色正文，灰色信息面板，IKB Blue `#123db5` 作为主动作色。
- 顶部使用双端等宽信息栏和细分隔线；标题采用大字号、轻字重和紧字距。
- 页面不使用渐变、阴影、圆角或毛玻璃；信息以直角面板和规则网格组织。
- 小标签、状态和页脚使用等宽大写字母，正文保留中文可读性。

## 2. 页面结构

### 首页

首页按参考页顺序固定为：

1. `P2P DELIVERY` / 会话编号顶栏。
2. `CREATE / JOIN TEMPORARY ROOM` 标签、双列 Hero 标题和右侧说明。
3. 蓝色“创建房间”面板。
4. 灰色“加入房间”面板，以及“直接连接 / 临时会话”信息卡。
5. 页脚协议说明与辅助链接。

真实 Dioxus 房间输入仍保留六格键盘、粘贴和错误反馈；视觉上组合成参考页中的单个长输入框。

### 房间页

房间页按参考页的第二态组织为：

1. `ACTIVE SESSION` / `TRANSFER BOARD · 02 / 04` 顶栏。
2. `ROOM STATUS / FILE DELIVERY` 标签、房间会话 Hero。
3. 左侧蓝色身份面板、连接状态、设备状态卡和三张能力卡。
4. 右侧 `FILE INPUT` 文件投递区与 `TRANSFER QUEUE` 文件队列。
5. 房间码复制、分享、退出、真实 WebRTC 文件传输和恢复逻辑继续由 Rust/Dioxus 驱动。

成员头像和旧活动侧栏不再作为主界面内容展示，避免偏离参考页面；成员状态仍保留在连接和传输状态模型中。

## 3. 交互与可访问性

- 所有动作使用直角按钮，最小高度 48px；移动端按钮占满可用宽度。
- 房间码支持单格输入、键盘移动、粘贴和 `Enter` 提交。
- 文件区域支持键盘触发、原生文件选择和真实拖放传输。
- 错误、等待、连接和完成状态同时提供文字，不依赖颜色单独表达。
- 保持可见焦点环、无横向滚动和 `prefers-reduced-motion` 支持。
- 断点与参考页一致：`1180px` 调整列宽，`960px` 改为单列，`680px` 压缩并全宽按钮，`440px` 进一步收紧内边距。

## 4. 产品边界

- 保留真实能力：匿名房间、邀请、房间恢复、请求授权、WebRTC 点对点传输、批量文件、文本传输、断点恢复、BLAKE3 校验和错误恢复。
- 删除主界面中与参考页无关的成员侧栏、活动记录、营销徽章和重复隐私标语。
- 参考页中的生成房间号只作为创建面板的视觉预览；真正的房间号仍以服务端创建结果为准。
