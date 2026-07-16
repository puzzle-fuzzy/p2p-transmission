# Rust M5：Dioxus 房间垂直切片结果

> 结论：**M5 通过，可以进入 M6 DataChannel 单接收者文件垂直切片。**

## 1. 本阶段交付结果

M5 第一次把 Rust 的 Dioxus 页面、Axum 控制面和实时房间协议连成完整用户链路。两个独立浏览器现在可以完成：

1. 发送者创建房间并打开分享弹窗；
2. 接收者通过房间码或邀请 fragment 申请加入；
3. 发送者收到实时申请并批准或拒绝；
4. 接收者进入房间，双方看到在线状态；
5. 新接收者头像按既有体验从小到大出现；
6. 发送者和接收者刷新后恢复各自房间角色；
7. 接收者取消等待时，服务端 pending request 同步取消，发送者不再看到过期申请。

本阶段仍不包含文件选择、WebRTC offer/answer 和 DataChannel 传输。页面中的传输区域只表达当前房间与连接状态，不伪装已经具备文件传输能力。

## 2. Dioxus 页面状态

`rust/apps/web/src/main.rs` 使用一个显式 `AppModel` 管理四种顶层页面状态：

- `Booting`：创建或恢复匿名 session；
- `Lobby`：输入房间码、读取邀请意图或创建房间；
- `Waiting`：保持 join watcher，等待发送者决定；
- `Room`：按 owner/receiver 角色展示 room snapshot、分享、审批、presence 与退出操作。

session 由 HttpOnly cookie 恢复；当前 room code、角色和幂等 request id 只保存到 2.0 独立 localStorage key。刷新后客户端先向服务端 bootstrap，不把本地存储当作权限依据。恢复失败会清理失效的本地 room 状态并返回首页。

邀请 capability 只存在于 URL fragment。浏览器平台层读取 `room` 与 `capability` 后立即使用 `history.replaceState` 清理地址栏，再由显式 join request 提交给服务端。分享弹窗重新生成同源 fragment 链接，页面正文不展示 capability。

## 3. 浏览器平台边界

`p2p-browser-platform` 现在统一封装：

- same-origin、带 cookie 的 typed fetch；
- session、room、invite、join、decision、leave、bootstrap 与 readiness API；
- WebSocket 创建、消息解析、事件闭包持有和 Drop 清理；
- localStorage、Clipboard、History、Location、timer 与客户端 request id；
- API `ErrorEnvelope` 到稳定 Rust error 的转换。

原生 WebSocket 回调不会直接裸写 Dioxus signal。Web 入口先把事件封装成 Dioxus `Callback`，再交给平台层持有；每次浏览器事件回调都会重新进入正确的 Dioxus runtime/scope。双浏览器追踪验证了这条边界，避免原生回调触发 runtime 缺失或 `RefCell` 重入 panic。

## 4. Join watcher 与恢复

接收者尚未获批时不是 room member，因此不能伪装成已 attach 的 peer。实时协议新增独立的 `WatchJoinRequest` / `JoinWatching` 流程：

- watcher 必须使用当前 session 自己的 pending request；
- watcher 不进入 participant presence，也没有 signaling route；
- owner 的 `JoinRequested` 与双方的 `JoinDecided` 仍通过同一 bounded hub 推送；
- watcher 断开只清理 watcher mapping，不产生错误的 PeerOffline；
- `GET /api/rooms/{code}/join-requests/{request_id}` 用于刷新和重连后的状态确认。

接收者点击“更换房间”时调用既有 leave command。领域层把其 pending request 转为 `Cancelled`，owner 收到 revision 变化后刷新 snapshot，申请弹窗立即消失。

## 5. 视觉与动效约束

M5 没有重新设计产品。页面继续使用 1.x 已锁定的克制基线：

- 深灰 `#2d2d2d` 背景与紫色 `#5e11d1` 交互色；
- 系统字体、低饱和层级文字、细边框和不超过 12px 的圆角；
- 无阴影、无渐变、无玻璃效果和装饰性大标题；
- 首页六格房间码、房间头部、PeerFlow、等待页和 dialog 均保持旧版信息密度；
- 1440px 与 390px 使用同一视觉语言，无水平溢出。

头像由 session id 确定性生成 5×5 identicon。只有 owner snapshot 中首次从“未在线/不存在”变为“在线”的 receiver 会加入 `avatar-entering` 集合：CSS 在 360ms 内从 `scale(0.68)` 过渡到 `scale(1)`，类名保留 700ms 后清除。普通 signal 重渲染和 owner 刷新不会重播；`prefers-reduced-motion: reduce` 会关闭动画。

## 6. 无障碍与交互

六个可视房间码格子背后只有一个真实文本输入，避免屏幕阅读器和键盘用户需要在六个控件间跳转。页面为等待状态、连接状态和错误反馈提供 live/status 语义；分享、加入审批与 About 使用原生 dialog role 和明确标题。所有主要按钮满足至少 44px 触控高度，移动端保持可操作间距。

M7 仍需完成完整 focus trap、Escape/焦点归还、Toast 时序和 M0 全状态矩阵；M5 不把这些未完成项宣称为体验等价。

## 7. 自动化与视觉验证

Playwright 在独立 browser context 中覆盖：

- owner 创建房间与分享弹窗；
- receiver 手动输入房间码并等待；
- owner 实时收到申请并批准；
- receiver 入房与双方 presence；
- receiver 头像入场动画名称、出现次数和清理；
- receiver 与 owner 分别刷新恢复；
- owner 刷新后头像不重复播放；
- receiver 取消 pending request 后双方立即回到一致状态；
- 首页、About、GitHub、readiness、响应式与水平溢出。

视觉检查截图：

- [发送者桌面端](../../release/screenshots/m5-room-owner-desktop-chromium.png)
- [发送者移动端](../../release/screenshots/m5-room-owner-mobile-chromium.png)
- [接收者桌面端](../../release/screenshots/m5-room-receiver-desktop-chromium.png)
- [接收者移动端](../../release/screenshots/m5-room-receiver-mobile-chromium.png)

通过的质量门禁：

```text
python -X utf8 scripts/verify.py
python -X utf8 scripts/test_e2e.py
```

Rust workspace 共 54 项测试通过；native 与 WASM strict Clippy、release server、Dioxus release build、文档链接和 `git diff --check` 全部通过。Playwright 在 1440px 与 390px Chromium 中运行 6 项测试，结果为 6/6 通过。

## 8. M6 起点

M6 将复用已经验证的房间、权限、presence 和 signaling route，把 spike 中的 `RTCPeerConnection`、offer/answer、trickle ICE 与 DataChannel 迁入正式 `browser-platform`。第一条文件链路只面向一个接收者，并必须同时具备 manifest 确认、二进制 chunk、BLAKE3 完整性、buffered amount 背压、取消和资源清理；不会在这一阶段提前扩展多接收者调度。
